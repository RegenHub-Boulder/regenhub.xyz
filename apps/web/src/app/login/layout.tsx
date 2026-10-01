import { PublicShell } from "@/components/layout/PublicShell";

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
