import Image from "next/image";
import Link from "next/link";
import InterestForm from "./InterestForm";
import regenHubFull from "@/assets/regenhub-full.svg";

export const metadata = { title: "Stay in Touch — RegenHub" };

export default function InterestPage() {
  return (
    <div className="min-h-screen px-6 py-12">
      <div className="max-w-xl mx-auto space-y-8">
        <div className="text-center">
          <Link href="/">
            <Image
              src={regenHubFull}
              alt="RegenHub"
              height={80}
              className="h-20 w-auto mx-auto mb-6 hover:opacity-80 transition-opacity"
            />
          </Link>
          <h1 className="text-3xl md:text-4xl font-bold text-forest mb-3">
            Stay in Touch
          </h1>
          <p className="text-muted max-w-md mx-auto">
            Not ready to commit but want to stay in the loop? Drop your email and
            we&apos;ll reach out about whatever interests you most.
          </p>
        </div>

        <InterestForm />

        <p className="text-xs text-center text-muted">
          Already a member?{" "}
          <Link href="/portal" className="underline hover:text-sage transition-colors">
            Sign in to your portal
          </Link>
        </p>
      </div>
    </div>
  );
}
