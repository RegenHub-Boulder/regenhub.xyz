export {
  MEMBER_SLOT_MIN,
  MEMBER_SLOT_MAX,
  DAY_CODE_SLOT_MIN,
  DAY_CODE_SLOT_MAX,
  generateRandomCode,
} from "./constants.js";

export {
  setUserCode,
  clearUserCode,
  formatLockWarning,
  formatLockStatus,
  LOCK_FAILURE_MSG,
  SUPPORT_CONTACT,
  type LockResult,
} from "./homeAssistant.js";

export { allocateSlotWithRetry } from "./slotAllocation.js";

export { defaultEmailFrom, defaultEmailReplyTo } from "./email.js";

export { unlockDoors, lockDoors, resolveDoorEntities, getLockEntities } from "./homeAssistant.js";
export { getEntityState, setAutomationEnabled, autoLockAutomationEntity } from "./homeAssistant.js";

export {
  signBridgeAssertion,
  verifyBridgeAssertion,
  type BridgeAssertion,
} from "./mcpBridge.js";
