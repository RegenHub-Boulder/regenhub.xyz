/**
 * The words of the note that goes out the day after a RegenHub night (lib/nightFollowups.ts). EDITABLE DATA: change
 * the wording here and nowhere else. Two notes: `guest` for anyone who isn't a member in standing, `member` for those
 * who are (lib/memberStanding.ts).
 *
 * Each entry is one paragraph. `{name}` fills in a value (escaped); `[words]({name})` is a link to the URL value
 * `name`. A paragraph whose values are missing is left out (so the member-page line shows only to members who
 * haven't set up their page, and the "next" line only for a night in a series).
 * Keep it short and plain: no hype words, no dash chains. It's signed from RegenHub, and replies go to a person.
 *
 * Values: first (first name), night (the night's name), weekday (the day it was on), series (its series name),
 * nextWhen + nextUrl (the next night of that series), studioWhen + studioUrl (the next Studio Night),
 * eventsUrl, membershipUrl, profileUrl.
 */
export const FOLLOWUP_COPY = {
  guest: {
    subject: "{night}, and what's next",
    paragraphs: [
      "Hi {first},",
      "Thanks for signing up for {night} on {weekday}. We hope you could make it.",
      "The next {series} is [{nextWhen}]({nextUrl}).",
      "See what else is coming up at [regenhub.xyz/events]({eventsUrl}).",
      "420 Happy Hour is every Friday and open to everyone. Come say hi.",
      "If you'd like to come closer, members get a few things of their own: on Fridays before Happy Hour they show each other what they're building, and Studio Night, the fourth Tuesday, is an evening to work on your agent, your data and your tools with people who get it. The next one is {studioWhen}.",
      "Membership starts at $30 a month. Here's what it includes: [regenhub.xyz/membership]({membershipUrl})",
    ],
  },
  member: {
    subject: "{night}, and what's next",
    paragraphs: [
      "Hi {first},",
      "Thanks for signing up for {night} on {weekday}. Hope it was a good one.",
      "The next Studio Night is [{studioWhen}]({studioUrl}). Bring whatever you're stuck on.",
      "Your member page isn't up yet. It takes a few minutes and helps the people you met find you again: [fill it in]({profileUrl}).",
    ],
  },
  signoff: "RegenHub",
  address: "1515 Walnut St, Suite 200, Boulder, CO",
  /** The two footer links, in this order. */
  noMoreFollowups: "No more notes after nights",
  unsubscribe: "Unsubscribe from the newsletter and these notes",
} as const;

export type FollowupVariant = "member" | "guest";
