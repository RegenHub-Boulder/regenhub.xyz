import Image from "next/image";
import Link from "next/link";
import { CheckCircle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import regenHubFull from "@/assets/regenhub-full.svg";

export const metadata = { title: "You're on the list — RegenHub" };

export default function InterestSuccessPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center">
          <Link href="/">
            <Image
              src={regenHubFull}
              alt="RegenHub"
              height={64}
              className="h-16 w-auto mx-auto mb-4 hover:opacity-80 transition-opacity"
            />
          </Link>
        </div>

        <Card className="glass-panel-strong">
          <CardContent className="p-10 text-center">
            <CheckCircle className="w-12 h-12 text-sage mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-forest mb-3">
              You&apos;re on the list!
            </h1>
            <p className="text-muted mb-2">
              Thanks for reaching out. We&apos;ll be in touch when there&apos;s
              something worth sharing.
            </p>
            <p className="text-sm text-muted mb-8">
              In the meantime, your first day at RegenHub is on us — come hang out.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/freeday">
                <Button className="btn-primary-glass">Try a Free Day</Button>
              </Link>
              <Link href="/">
                <Button variant="ghost" className="btn-glass gap-2">
                  <ArrowLeft className="w-4 h-4" />
                  Back home
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
