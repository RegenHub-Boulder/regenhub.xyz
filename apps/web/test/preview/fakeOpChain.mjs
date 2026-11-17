// A fake OP Mainnet JSON-RPC for local previews: just enough chain for the
// USDC flows (wallet balance, the gasless relay's transferWithAuthorization,
// receipts). No real chain, no real keys, nothing leaves the machine.
//
// Every relayed authorization becomes a successful receipt carrying the exact
// USDC Transfer it authorizes; the app's own verifier then checks it like a
// real one. Set PREVIEW_CHAIN_SHORTFALL_MICROS to shave that many micros off
// each transfer and watch the wrong-amount path instead.
import { createServer } from "node:http";
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, parseAbiItem,
  parseTransaction, recoverTransactionAddress, toHex,
} from "viem";

const USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const AUTH_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const ZERO32 = `0x${"0".repeat(64)}`;

export function startFakeOpChain(port, { shortfallMicros = 0n } = {}) {
  let block = 1_000n;
  const receipts = new Map();
  const usedNonces = new Set();
  const logs = [];

  const blockHash = (n) => keccak256(toHex(`block-${n}`));
  const blockObject = (n) => ({
    number: toHex(n), hash: blockHash(n), parentHash: blockHash(n - 1n), timestamp: toHex(Math.floor(Date.now() / 1000)),
    nonce: "0x0000000000000000", difficulty: "0x0", totalDifficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0",
    miner: "0x4200000000000000000000000000000000000011", extraData: "0x", baseFeePerGas: "0x1", logsBloom: `0x${"0".repeat(512)}`,
    sha3Uncles: ZERO32, stateRoot: ZERO32, transactionsRoot: ZERO32, receiptsRoot: ZERO32, mixHash: ZERO32, size: "0x0",
    transactions: [], uncles: [],
  });
  const blockNumberOf = (tag) => (tag === "latest" || tag === "safe" || tag === "finalized" || tag === "pending" || tag == null ? block : BigInt(tag));

  async function sendRaw(raw) {
    const tx = parseTransaction(raw);
    const relayer = await recoverTransactionAddress({ serializedTransaction: raw });
    const { functionName, args } = decodeFunctionData({ abi: USDC_ABI, data: tx.data });
    if (functionName !== "transferWithAuthorization") throw new Error("fake chain only relays transferWithAuthorization");
    const [from, to, value, , , nonce] = args;
    const nonceKey = `${from.toLowerCase()}:${nonce}`;
    if (usedNonces.has(nonceKey)) throw new Error("FiatTokenV2: authorization is used or canceled");
    usedNonces.add(nonceKey);
    block += 1n;
    const hash = keccak256(raw);
    const amount = value - shortfallMicros;
    const base = { address: USDC, blockHash: blockHash(block), blockNumber: toHex(block), transactionHash: hash, transactionIndex: "0x0", removed: false };
    const txLogs = [
      { ...base, logIndex: "0x0", topics: encodeEventTopics({ abi: [AUTH_USED], eventName: "AuthorizationUsed", args: { authorizer: from, nonce } }), data: "0x" },
      { ...base, logIndex: "0x1", topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [amount]) },
    ];
    logs.push(...txLogs);
    receipts.set(hash, {
      transactionHash: hash, transactionIndex: "0x0", blockHash: blockHash(block), blockNumber: toHex(block),
      from: relayer, to: USDC, cumulativeGasUsed: "0x10000", gasUsed: "0x10000", effectiveGasPrice: "0x1",
      contractAddress: null, logs: txLogs, logsBloom: `0x${"0".repeat(512)}`, status: "0x1", type: "0x2",
    });
    console.log(`[fake-op] relayed ${Number(amount) / 1e6} USDC ${from} -> ${to} in ${hash}`);
    return hash;
  }

  async function call({ data }) {
    const selector = data.slice(0, 10);
    if (selector === "0x70a08231") return encodeAbiParameters([{ type: "uint256" }], [1_000_000_000n]); // balanceOf: 1,000 USDC
    if (selector === "0xe94a0102") { // authorizationState(address, bytes32)
      const from = `0x${data.slice(34, 74)}`.toLowerCase();
      const nonce = `0x${data.slice(74, 138)}`;
      return encodeAbiParameters([{ type: "bool" }], [usedNonces.has(`${from}:${nonce}`)]);
    }
    throw new Error(`fake chain: unsupported eth_call ${selector}`);
  }

  const methods = {
    eth_chainId: () => "0xa",
    net_version: () => "10",
    eth_blockNumber: () => toHex(block),
    eth_getBlockByNumber: ([tag]) => blockObject(blockNumberOf(tag)),
    eth_getCode: () => "0x",
    eth_call: ([req]) => call(req),
    eth_getLogs: ([filter]) => logs.filter((log) => {
      const n = BigInt(log.blockNumber);
      return n >= blockNumberOf(filter.fromBlock ?? "0x0") && n <= blockNumberOf(filter.toBlock);
    }),
    eth_getTransactionCount: () => "0x0",
    eth_estimateGas: () => "0x30000",
    eth_gasPrice: () => "0x1",
    eth_maxPriorityFeePerGas: () => "0x1",
    eth_feeHistory: () => ({ oldestBlock: toHex(block), baseFeePerGas: ["0x1", "0x1"], gasUsedRatio: [0.1], reward: [["0x1"]] }),
    eth_sendRawTransaction: ([raw]) => sendRaw(raw),
    eth_getTransactionReceipt: ([hash]) => receipts.get(hash) ?? null,
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const handle = async (msg) => {
        try {
          const fn = methods[msg.method];
          if (!fn) throw new Error(`fake chain: unsupported method ${msg.method}`);
          return { jsonrpc: "2.0", id: msg.id, result: await fn(msg.params ?? []) };
        } catch (error) {
          return { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
        }
      };
      const parsed = JSON.parse(body || "{}");
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(out));
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}
