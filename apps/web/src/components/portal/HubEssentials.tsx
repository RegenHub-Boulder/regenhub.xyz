"use client";

import { useState } from "react";
import {
  MapPin,
  Clock,
  Key,
  Wifi,
  Coffee,
  Heart,
  MessageCircle,
  ChevronDown,
} from "lucide-react";

type Props = {
  /** Whether to start expanded (true for new members / free day visitors) */
  defaultExpanded?: boolean;
  /** Show free-day-specific hours instead of member hours */
  freeDay?: boolean;
  className?: string;
};

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof MapPin;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <Icon className="w-5 h-5 text-sage mt-0.5 shrink-0" />
      <div className="space-y-1">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <div className="text-xs text-muted leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export default function HubEssentials({
  defaultExpanded = true,
  freeDay = false,
  className = "",
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className={`glass-panel overflow-hidden ${className}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-white/5 transition-colors"
      >
        <h3 className="text-lg font-semibold text-forest">Hub Essentials</h3>
        <ChevronDown
          className={`w-5 h-5 text-muted transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {expanded && (
        <div className="px-6 pb-6 space-y-5 border-t border-white/10 pt-5">
          <Section icon={MapPin} title="Location">
            <p>
              1515 Walnut St, Suite 200, Boulder, CO 80302
              <br />
              2nd floor — take the elevator or stairs from the lobby.
            </p>
          </Section>

          <Section icon={Clock} title="Hours">
            {freeDay ? (
              <p>
                Your free day pass is valid{" "}
                <strong className="text-foreground">8 AM – 6 PM</strong>.
                <br />
                Full members enjoy 24/7 access.
              </p>
            ) : (
              <p>
                Members have 24/7 access with their door code.
                <br />
                Core community hours: 8 AM – 6 PM weekdays.
              </p>
            )}
          </Section>

          <Section icon={Key} title="Using the Keypad">
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Enter your PIN code on the keypad</li>
              <li>
                Press the <strong className="text-foreground">#</strong> key
              </li>
              <li>Wait for the green LED and click sound</li>
              <li>Pull the door handle within 5 seconds</li>
            </ol>
          </Section>

          <Section icon={Wifi} title="WiFi">
            <p>
              Ask a member or admin for the current WiFi credentials when you
              arrive.
            </p>
          </Section>

          <Section icon={Coffee} title="Amenities">
            <ul className="list-disc list-inside space-y-0.5">
              <li>Standing desks and ergonomic seating</li>
              <li>High-speed fiber internet</li>
              <li>Kitchen with coffee, tea, and filtered water</li>
              <li>Meeting room (reserve via the Telegram group)</li>
            </ul>
          </Section>

          <Section icon={Heart} title="Community Norms">
            <ul className="list-disc list-inside space-y-0.5">
              <li>Keep shared spaces tidy — clean up after yourself</li>
              <li>Use headphones for calls and music</li>
              <li>Be welcoming to new faces</li>
              <li>The door auto-locks — just pull it closed when you leave</li>
            </ul>
          </Section>

          <Section icon={MessageCircle} title="Questions?">
            <p>
              Email us at{" "}
              <a
                href="mailto:boulder.regenhub@gmail.com"
                className="text-sage hover:underline"
              >
                boulder.regenhub@gmail.com
              </a>
            </p>
          </Section>
        </div>
      )}
    </div>
  );
}
