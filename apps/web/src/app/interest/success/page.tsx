import Image from "next/image";
import Link from "next/link";
import { CheckCircle, ArrowLeft, Zap, Key, ArrowRight } from "lucide-react";
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
            <p className="text-sm text-muted mb-6">
              In the meantime — there&apos;s no need to wait.
            </p>

            <div className="grid sm:grid-cols-2 gap-3 mb-6 text-left">
              <Link href="/freeday">
                <Card className="glass-panel hover-lift cursor-pointer h-full">
                  <CardContent className="p-4">
                    <Zap className="w-6 h-6 text-gold mb-2" />
                    <p className="font-medium text-sm mb-1">Try a Free Day</p>
                    <p className="text-xs text-muted">
                      Your first day&apos;s on us — see if RegenHub fits.
                    </p>
                    <p className="text-xs text-sage mt-2 inline-flex items-center gap-1">
                      Get a code <ArrowRight className="w-3 h-3" />
                    </p>
                  </CardContent>
                </Card>
              </Link>

              <a href="mailto:boulder.regenhub@gmail.com?subject=Interested in desk membership">
                <Card className="glass-panel hover-lift cursor-pointer h-full">
                  <CardContent className="p-4">
                    <Key className="w-6 h-6 text-sage mb-2" />
                    <p className="font-medium text-sm mb-1">See Membership</p>
                    <p className="text-xs text-muted">
                      Desks from $250/mo. Permanent code, 24/7 access.
                    </p>
                    <p className="text-xs text-sage mt-2 inline-flex items-center gap-1">
                      Inquire <ArrowRight className="w-3 h-3" />
                    </p>
                  </CardContent>
                </Card>
              </a>
            </div>

            <Link href="/">
              <Button variant="ghost" className="btn-glass gap-2 text-xs">
                <ArrowLeft className="w-3 h-3" />
                Back home
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
