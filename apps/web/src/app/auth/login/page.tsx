import { LoginForm } from "@/components/auth/LoginForm";

export const metadata = { title: "Sign In — RegenHub" };

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="glass-panel-strong p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-forest mb-2">Member Portal</h1>
            <p className="text-muted text-sm">Enter your email and we'll send you a magic link.</p>
          </div>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
