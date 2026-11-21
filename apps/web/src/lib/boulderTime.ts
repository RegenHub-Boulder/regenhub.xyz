/** "Nov 20, 3:04 PM" in Boulder time, as the admin shows times. Client-safe. */
export function fmtBoulderDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Denver",
  });
}
