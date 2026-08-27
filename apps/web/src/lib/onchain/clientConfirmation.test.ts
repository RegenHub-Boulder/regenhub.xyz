import { afterEach, describe, expect, it, vi } from "vitest";
import { pollOnchainPayment } from "./clientConfirmation";

const txHash = `0x${"ab".repeat(32)}` as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollOnchainPayment", () => {
  it("continues from submitted through detected until the invoice is paid", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "submitted" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "detected" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "paid" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onStatus = vi.fn();

    await expect(pollOnchainPayment({
      invoiceId: 101,
      txHash,
      attempts: 3,
      intervalMs: 0,
      onStatus,
    })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onStatus.mock.calls.map(([status]) => status)).toEqual(["submitted", "detected", "paid"]);
  });

  it("returns pending after the bounded confirmation window without creating another payment", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => (
      new Response(JSON.stringify({ status: "detected" }), { status: 202 })
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollOnchainPayment({
      invoiceId: 101,
      txHash,
      attempts: 2,
      intervalMs: 0,
    })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/portal/onchain/submit", expect.objectContaining({
      body: JSON.stringify({ invoice_id: 101, tx_hash: txHash }),
    }));
  });
});
