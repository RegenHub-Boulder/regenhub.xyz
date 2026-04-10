"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Ticket, Plus, Minus } from "lucide-react";

interface Props {
  memberId: number;
  initialBalance: number;
}

export function AddPassesCard({ memberId, initialBalance }: Props) {
  const [balance, setBalance] = useState(initialBalance);
  const [count, setCount] = useState("10");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdjust(direction: "add" | "subtract") {
    const n = parseInt(count);
    if (!n || n < 1) return;
    if (direction === "subtract" && n > balance) {
      setError(`Cannot subtract ${n} — current balance is ${balance}`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${memberId}/add-passes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: direction === "add" ? n : -n }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setBalance(json.balance);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="glass-panel">
      <CardContent className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Ticket className="w-5 h-5 text-sage" />
          <h3 className="font-semibold">Day Pass Balance</h3>
        </div>

        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <p className="text-xs text-muted mb-1">Current balance</p>
            <p className={`text-4xl font-bold ${balance > 0 ? "text-gold" : "text-muted"}`}>{balance}</p>
          </div>

          <div className="flex items-center gap-2 pb-1">
            <Input
              type="number"
              min="1"
              max="1000"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              className="glass-input w-24"
            />
            <Button
              type="button"
              onClick={() => handleAdjust("add")}
              disabled={loading}
              className="btn-primary-glass gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Add
            </Button>
            <Button
              type="button"
              onClick={() => handleAdjust("subtract")}
              disabled={loading || balance === 0}
              className="bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 gap-1.5"
            >
              <Minus className="w-4 h-4" />
              Subtract
            </Button>
          </div>
        </div>

        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
      </CardContent>
    </Card>
  );
}
