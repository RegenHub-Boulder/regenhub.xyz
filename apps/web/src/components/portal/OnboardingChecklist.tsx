import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Circle, Sparkles, ExternalLink } from "lucide-react";

const TELEGRAM_GROUP_URL = "https://t.me/+Mg1PLuT9pX9mMGVh";

interface ChecklistItem {
  key: string;
  label: string;
  hint?: string;
  href: string;
  external?: boolean;
  done: boolean;
}

interface Props {
  hasPinCode: boolean;
  hasPhoto: boolean;
  hasBio: boolean;
  hasTelegram: boolean;
  needsPinCode: boolean;
}

/**
 * Lightweight "get oriented" checklist shown to new members on /portal.
 *
 * Goal: help someone arriving for their first day pass — or stepping into a
 * full membership — get connected to the community and the space. Each item
 * has a one-line "why this matters" hint so it doesn't feel like a chore.
 */
export function OnboardingChecklist({ hasPinCode, hasPhoto, hasBio, hasTelegram, needsPinCode }: Props) {
  const items: ChecklistItem[] = [];

  if (needsPinCode) {
    items.push({
      key: "pin",
      label: "Set your permanent door code",
      hint: "Your 6-digit PIN for the front-door keypad — pick something you'll remember.",
      href: "/portal/my-code",
      done: hasPinCode,
    });
  }

  items.push(
    {
      key: "tg",
      label: "Join the RegenHub Telegram group",
      hint: "Where the community lives day-to-day — questions, intros, events, mutual aid.",
      href: TELEGRAM_GROUP_URL,
      external: true,
      done: hasTelegram, // we use the same flag as a proxy for "has connected to Telegram"
    },
    {
      key: "photo",
      label: "Add a profile photo",
      hint: "Helps members recognize you in the directory and at the space.",
      href: "/portal/profile",
      done: hasPhoto,
    },
    {
      key: "bio",
      label: "Write a short bio",
      hint: "What you're working on, what you're curious about — helps others find common ground.",
      href: "/portal/profile",
      done: hasBio,
    },
    {
      key: "tg_handle",
      label: "Add your Telegram username to your profile",
      hint: "So members can DM you directly.",
      href: "/portal/profile",
      done: hasTelegram,
    },
  );

  const doneCount = items.filter((i) => i.done).length;
  if (doneCount === items.length) return null;

  return (
    <Card className="glass-panel border border-gold/30 bg-gold/[0.03]">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-gold" />
            <h3 className="font-semibold">Get oriented</h3>
          </div>
          <p className="text-xs text-muted tabular-nums">{doneCount} of {items.length}</p>
        </div>
        <p className="text-xs text-muted mb-3">
          A few small steps to plug into the RegenHub community.
        </p>

        <ul className="space-y-1">
          {items.map((item) => {
            const linkProps = item.external
              ? { href: item.href, target: "_blank" as const, rel: "noopener noreferrer" }
              : { href: item.href };
            return (
              <li key={item.key}>
                {item.done ? (
                  <div className="flex items-start gap-2.5 px-2 py-1.5 text-sm">
                    <CheckCircle2 className="w-4 h-4 text-sage shrink-0 mt-0.5" />
                    <span className="text-muted line-through">{item.label}</span>
                  </div>
                ) : (
                  <Link
                    {...linkProps}
                    className="flex items-start gap-2.5 px-2 py-1.5 text-sm rounded hover:bg-white/5 transition-colors"
                  >
                    <Circle className="w-4 h-4 text-muted shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-foreground inline-flex items-center gap-1">
                        {item.label}
                        {item.external && <ExternalLink className="w-3 h-3 text-muted" />}
                      </p>
                      {item.hint && <p className="text-xs text-muted mt-0.5">{item.hint}</p>}
                    </div>
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
