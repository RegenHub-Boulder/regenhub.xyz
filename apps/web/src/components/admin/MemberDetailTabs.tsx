"use client";

import { AdminTabs, type TabDef } from "./AdminTabs";

export type TabKey = "overview" | "billing" | "access" | "activity";

const TABS: TabDef<TabKey>[] = [
  { key: "overview", label: "Overview" },
  { key: "billing",  label: "Billing" },
  { key: "access",   label: "Access" },
  { key: "activity", label: "Activity" },
];

interface Props {
  children: Record<TabKey, React.ReactNode>;
}

export function MemberDetailTabs({ children }: Props) {
  return <AdminTabs tabs={TABS}>{children}</AdminTabs>;
}
