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
export {
  getEntityState,
  setAutomationEnabled,
  autoLockAutomationEntity,
  bothDoorsAutoLockAutomationEntity,
  backAutoLockAutomationEntity,
  isFrontLockEntity,
  withoutFrontLocks,
} from "./homeAssistant.js";

export {
  withLockWriter, lockWriterFetch, assertLockWriter, quarantinedSlots, quarantineSlot, clearSlotSafely, recordLockWriterFailure,
  LockWriterBusyError, LOCK_WRITER_BUSY_MESSAGE, LOCK_WRITER_LEASE_SECONDS, LOCK_WRITER_RENEW_MS,
} from "./lockSlotSafety.js";

export { DAY_PASS_PUBLIC_CENTS, DAY_PASS_MEMBER_CENTS, PLAN_MONTHLY_CENTS, FREE_DAY_LAPSE_DAYS, dollars } from "./prices.js";
export { freeDayUsedLine, shortDay } from "./freeDayWords.js";
export {
  freeDayApprovedEmail,
  freeDayPlusMembershipApprovedEmail,
  freeDayReceivedEmail,
  freeDayDeclinedEmail,
  freeDayAlreadyMemberEmail,
  membershipApprovedEmail,
  freeDayMorningEmail,
  type EmailTemplate,
} from "./freeDayEmails.js";
export {
  ADDRESS, ARRIVAL_STEPS, BRING_LINE, arrivalSection,
  USUALLY_HERE_WEEKS, weekdayArrivals, usuallyHereLine, usuallyHereFromEntries, readUsuallyHere, type WeekdayArrivals,
  chatFirstName, firstVisitChatMessage, plannedVisitChatMessage, type FirstVisitKind,
  planDays, boulderToday, plannedDayWords, type PlanDay,
} from "./firstVisitWords.js";
