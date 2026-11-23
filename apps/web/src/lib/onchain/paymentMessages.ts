/**
 * What the card says when something fails after the member signed. Only a submission
 * the server says is queued may claim "RegenHub will retry"; any other failure
 * (a poll error, a 404 after the payment already finished) must not.
 */
export const PAYMENT_CONFIRMED_MESSAGE = "Payment confirmed — membership is active.";
export const AUTHORIZATION_QUEUED_MESSAGE =
  "Your authorization was saved. Do not authorize again; RegenHub will retry the gas-sponsored submission.";

export class QueuedAuthorizationError extends Error {}

export function messageAfterSignedFailure(error: unknown): { error: string; message: string } {
  if (error instanceof QueuedAuthorizationError) {
    return { error: error.message, message: AUTHORIZATION_QUEUED_MESSAGE };
  }
  return {
    error: error instanceof Error ? error.message : "Could not confirm the payment",
    message: "Your payment may already have gone through. Do not pay again; reload this page to see its status.",
  };
}
