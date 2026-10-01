import { PublicShell } from "@/components/layout/PublicShell";

export default function ApplyLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
