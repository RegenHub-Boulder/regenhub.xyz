import type { NavLink } from "@/components/nav/MobileNav";

/**
 * The public site's one nav. Header and footer both read it so a stranger sees
 * the same four doors everywhere, in the same order.
 */
export const PUBLIC_NAV: NavLink[] = [
  { href: "/events", label: "Events" },
  { href: "/membership", label: "Membership" },
  { href: "/news", label: "News" },
  { href: "/freeday", label: "Free Day" },
];

/** Street address, one place. Deliberately no opening hours — we don't publish them. */
export const HUB_ADDRESS = "1515 Walnut St, Suite 200, Boulder, CO 80302";
export const HUB_EMAIL = "boulder.regenhub@gmail.com";
export const HUB_TELEGRAM = "https://t.me/+Mg1PLuT9pX9mMGVh";
