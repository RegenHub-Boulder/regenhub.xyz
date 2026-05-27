import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Circle, Sparkles } from "lucide-react";

interface ChecklistItem {
  key: string;
  label: string;
  href: string;
  done: boolean;
}

interface Props {
  hasPinCode: boolean;
  hasPhoto: boolean;
  hasBio: boolean;
  hasTelegram: boolean;
  needsPinCode: boolean;
}

export function OnboardingChecklist({ hasPinCode, hasPhoto, hasBio, hasTelegram, needsPinCode }: Props) {
  const items: ChecklistItem[] = [];

  if (needsPinCode) {
    items.push({
      key: "pin",
      label: "Set your permanent door code",
      href: "/portal/my-code",
      done: hasPinCode,
    });
  }
  items.push(
    { key: "photo", label: "Add a profile photo", href: "/portal/profile", done: hasPhoto },
    { key: "bio", label: "Write a short bio", href: "/portal/profile", done: hasBio },
    { key: "tg", label: "Add your Telegram username", href: "/portal/profile", done: hasTelegram },
  );

  const doneCount = items.filter((i) => i.done).length;
  if (doneCount === items.length) return null;

  return (
    <Card className="glass-panel border border-gold/30 bg-gold/[0.03]">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-gold" />
            <h3 className="font-semibold">Get set up</h3>
          </div>
          <p className="text-xs text-muted tabular-nums">{doneCount} of {items.length} done</p>
        </div>

        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.key}>
              {item.done ? (
                <div className="flex items-center gap-2.5 px-2 py-1.5 text-sm text-muted line-through">
                  <CheckCircle2 className="w-4 h-4 text-sage shrink-0" />
                  {item.label}
                </div>
              ) : (
                <Link
                  href={item.href}
                  className="flex items-center gap-2.5 px-2 py-1.5 text-sm rounded hover:bg-white/5 transition-colors"
                >
                  <Circle className="w-4 h-4 text-muted shrink-0" />
                  {item.label}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
