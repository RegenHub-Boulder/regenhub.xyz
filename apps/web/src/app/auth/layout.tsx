import { PublicShell } from "@/components/layout/PublicShell";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
