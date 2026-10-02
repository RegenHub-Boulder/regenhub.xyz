import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Install PGlite in a disposable directory; never use a remote database here.
// See docs/door-slot-implementation-report.md for the pinned setup command.
const { PGlite } = await import(process.env.PGLITE_MODULE ?? '@electric-sql/pglite');
const migration = await readFile(new URL('../../../supabase/migrations/053_door_slot_ownership.sql', import.meta.url), 'utf8');
const seed = await readFile(new URL('../../../supabase/seed.sql', import.meta.url), 'utf8');
const id = '00000000-0000-0000-0000-000000000001';
async function setup() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(migration);
  await db.exec(seed);
  await db.exec("insert into door_slot_targets values ('front'),('back');");
  return db;
}
async function recover(db, slot=101, generation=0, barrier='clock_timestamp()', entities="ARRAY['front','back']", times='ARRAY[clock_timestamp(),clock_timestamp()]') {
  return db.exec(`select door_slot_recover(${slot},${generation},'offline drain',${barrier},${entities},${times})`);
}
test('migration executes and post-seed privileges retain RPC-only service access', async () => {
  const db = await setup();
  try {
    assert.equal((await db.query('select count(*)::int n from door_slots')).rows[0].n, 200);
    for (const role of ['anon','authenticated','service_role']) {
      for (const table of ['door_slots','door_slot_targets','door_slot_operations','door_slot_recoveries']) {
        for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
          assert.equal((await db.query(`select has_table_privilege('${role}','${table}','${privilege}') allowed`)).rows[0].allowed, false, `${role} ${table} ${privilege}`);
        }
      }
      assert.equal((await db.query(`select has_sequence_privilege('${role}','door_slot_recoveries_id_seq','USAGE') allowed`)).rows[0].allowed, false);
      for (const signature of ['door_slot_reserve(integer,text,uuid,text)', 'door_slot_quarantine(integer,bigint,uuid)']) {
        assert.equal((await db.query(`select has_function_privilege('${role}','${signature}','EXECUTE') allowed`)).rows[0].allowed, role === 'service_role');
      }
      await db.exec(`set role ${role}`);
      await assert.rejects(db.exec('update door_slots set state=\'free\' where slot=101'), /permission denied/);
      await assert.rejects(recover(db), /permission denied/);
      if (role !== 'service_role') await assert.rejects(db.exec(`select door_slot_reserve(101,'owner','${id}','clear')`), /permission denied/);
      await db.exec('reset role');
    }
    await recover(db);
    await db.exec('set role service_role');
    await db.exec(`select door_slot_reserve(101,'owner','${id}','clear'); select door_slot_quarantine(101,1,'${id}')`);
  } finally { await db.close(); }
});
test('initial quarantine rejects evidence predating initialization', async () => {
  const db = await setup();
  try { await assert.rejects(recover(db,101,0,"'2000-01-01'::timestamptz",undefined,"ARRAY['2000-01-02'::timestamptz,'2000-01-02'::timestamptz]"), /fresh empty readback/); }
  finally { await db.close(); }
});
test('exact-door, malformed and timestamp evidence fails closed; current evidence recovers', async () => {
  const db = await setup();
  try {
    for (const entities of ["ARRAY['front']", "ARRAY['front','front']", "ARRAY['front','back','extra']", 'NULL', "ARRAY['front',NULL]", "ARRAY[['front','back']]"]) {
      await assert.rejects(recover(db,101,0,undefined,entities));
    }
    for (const times of ['ARRAY[[clock_timestamp(),clock_timestamp()]]', 'NULL', 'ARRAY[clock_timestamp()]', 'ARRAY[NULL::timestamptz,clock_timestamp()]', "ARRAY['2000-01-01'::timestamptz,clock_timestamp()]", "ARRAY[clock_timestamp()+interval '1 day',clock_timestamp()]"]) await assert.rejects(recover(db,101,0,undefined,undefined,times));
    await assert.rejects(recover(db,101,0,"clock_timestamp()+interval '1 day'"));
    await assert.rejects(recover(db,101,1));
    for (const evidence of ['NULL', "''", "'   '"]) await assert.rejects(db.exec(`select door_slot_recover(101,0,${evidence},clock_timestamp(),ARRAY['front','back'],ARRAY[clock_timestamp(),clock_timestamp()])`));
    await db.exec('begin');
    await recover(db);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from door_slot_recoveries')).rows[0].n, 0);
    assert.equal((await db.query('select state from door_slots where slot=101')).rows[0].state, 'quarantined');
    await recover(db);
    assert.equal((await db.query('select state from door_slots where slot=101')).rows[0].state,'free');
  } finally { await db.close(); }
});
test('generation fencing, replay tombstone, rollback and overlapping reservations', async () => {
  const db = await setup();
  try {
    await recover(db);
    await db.exec('begin');
    await db.exec(`select door_slot_reserve(101,'owner','${id}','clear')`);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from door_slot_operations')).rows[0].n,0);
    // PGlite queues one connection: overlap tests competing requests, not independent row-lock contention.
    const results = await Promise.allSettled([db.exec(`select door_slot_reserve(101,'owner','${id}','clear')`),db.exec("select door_slot_reserve(101,'other','00000000-0000-0000-0000-000000000002','set')")]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    await assert.rejects(db.exec(`select door_slot_quarantine(101,0,'${id}')`), /Stale/);
    await assert.rejects(db.exec("select door_slot_quarantine(101,1,'00000000-0000-0000-0000-000000000002')"), /Stale/);
    await db.exec(`select door_slot_quarantine(101,1,'${id}')`);
    await assert.rejects(recover(db,101,0));
    await assert.rejects(recover(db,101,1,"'2000-01-01'::timestamptz"));
    await db.exec("delete from door_slot_targets where entity='back'");
    await assert.rejects(recover(db,101,1,undefined,"ARRAY['front']",'ARRAY[clock_timestamp()]'));
    await db.exec("insert into door_slot_targets values ('back')");
    await recover(db,101,1);
    await assert.rejects(db.exec(`select door_slot_reserve(101,'owner','${id}','clear')`), /duplicate key/);
    assert.equal((await db.query('select generation::int g,state from door_slots where slot=101')).rows[0].g,1);
    await db.exec("select door_slot_reserve(101,'owner','00000000-0000-0000-0000-000000000003','set')");
    await assert.rejects(db.exec(`select door_slot_quarantine(101,1,'${id}')`));
  } finally { await db.close(); }
});
