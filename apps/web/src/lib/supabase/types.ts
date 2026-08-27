export type MemberType = "cold_desk" | "hot_desk" | "hub_friend" | "day_pass";
export type ApplicationStatus = "pending" | "approved" | "rejected" | "closed";
export type MembershipInterest =
  | "daypass_single"
  | "daypass_5pack"
  | "hot_desk"
  | "reserved_desk"
  | "member_basic"
  | "member_2day"
  | "member_5day";
export type AccessMethod = "nfc" | "pin" | "daycode";
// Free text — concrete plan keys live in apps/web/src/lib/stripe.ts PLANS.
// Typed as string here so adding new plans (social, events, etc.) doesn't
// require touching the DB schema or this file.
export type PlanKey = string;
export type DiscountDuration = "forever" | "repeating";
export type PurchaseKind = "day_pass" | "five_pack";
export type PaymentRail = "stripe" | "onchain";
export type OnchainInvoiceStatus =
  | "open"
  | "submitted"
  | "detected"
  | "paid"
  | "expired"
  | "void"
  | "exception";

// Mirrors Stripe.Subscription.Status verbatim
export type StripeSubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "unpaid"
  | "paused";

export interface Database {
  public: {
    Tables: {
      applications: {
        Row: {
          id: number;
          supabase_user_id: string | null;
          email: string;
          name: string;
          telegram: string | null;
          about: string | null;
          why_join: string | null;
          membership_interest: MembershipInterest;
          status: ApplicationStatus;
          admin_notes: string | null;
          approved_plan_key: PlanKey | null;
          approved_monthly_cents: number | null;
          approved_by: number | null;
          rejected_by: number | null;
          rejected_at: string | null;
          discount_cents: number | null;
          discount_duration: DiscountDuration | null;
          discount_months: number | null;
          discount_note: string | null;
          stripe_checkout_session_id: string | null;
          stripe_checkout_url: string | null;
          checkout_sent_at: string | null;
          checkout_completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          supabase_user_id?: string | null;
          email: string;
          name: string;
          telegram?: string | null;
          about?: string | null;
          why_join?: string | null;
          membership_interest?: MembershipInterest;
          status?: ApplicationStatus;
          admin_notes?: string | null;
          approved_plan_key?: PlanKey | null;
          approved_monthly_cents?: number | null;
          approved_by?: number | null;
          rejected_by?: number | null;
          rejected_at?: string | null;
          discount_cents?: number | null;
          discount_duration?: DiscountDuration | null;
          discount_months?: number | null;
          discount_note?: string | null;
          stripe_checkout_session_id?: string | null;
          stripe_checkout_url?: string | null;
          checkout_sent_at?: string | null;
          checkout_completed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["applications"]["Insert"]>;
        Relationships: [];
      };
      members: {
        Row: {
          id: number;
          supabase_user_id: string | null;
          name: string;
          email: string | null;
          telegram_username: string | null;
          ethereum_address: string | null;
          did: string | null;
          nfc_key_address: string | null;
          pin_code: string | null;
          pin_code_slot: number | null;
          member_type: MemberType;
          is_coop_member: boolean;
          is_admin: boolean;
          is_ops_admin: boolean;
          disabled: boolean;
          day_passes_balance: number;
          bio: string | null;
          skills: string[] | null;
          profile_photo_url: string | null;
          show_in_directory: boolean;
          stripe_customer_id: string | null;
          approved_for_daily: boolean;
          approved_for_daily_at: string | null;
          approved_for_daily_by: number | null;
          approved_for_full: boolean;
          approved_for_full_at: string | null;
          approved_for_full_by: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          supabase_user_id?: string | null;
          name: string;
          email?: string | null;
          telegram_username?: string | null;
          ethereum_address?: string | null;
          did?: string | null;
          nfc_key_address?: string | null;
          pin_code?: string | null;
          pin_code_slot?: number | null;
          member_type: MemberType;
          is_coop_member?: boolean;
          is_admin?: boolean;
          is_ops_admin?: boolean;
          disabled?: boolean;
          day_passes_balance?: number;
          bio?: string | null;
          skills?: string[] | null;
          profile_photo_url?: string | null;
          stripe_customer_id?: string | null;
          approved_for_daily?: boolean;
          approved_for_daily_at?: string | null;
          approved_for_daily_by?: number | null;
          approved_for_full?: boolean;
          approved_for_full_at?: string | null;
          approved_for_full_by?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["members"]["Insert"]>;
        Relationships: [];
      };
      day_passes: {
        Row: {
          id: number;
          member_id: number;
          allowed_uses: number;
          used_count: number;
          expires_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["day_passes"]["Row"], "id" | "created_at" | "updated_at">;
        Update: Partial<Database["public"]["Tables"]["day_passes"]["Insert"]>;
        Relationships: [];
      };
      day_codes: {
        Row: {
          id: number;
          day_pass_id: number | null;
          member_id: number | null;
          label: string | null;
          code: string;
          pin_slot: number;
          issued_at: string;
          expires_at: string | null;
          revoked_at: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          day_pass_id?: number | null;
          member_id?: number | null;
          label?: string | null;
          code: string;
          pin_slot: number;
          issued_at?: string;
          expires_at?: string | null;
          revoked_at?: string | null;
          is_active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["day_codes"]["Insert"]>;
        Relationships: [];
      };
      access_logs: {
        Row: {
          id: number;
          member_id: number | null;
          method: AccessMethod;
          slot: number | null;
          result: "granted" | "denied";
          note: string | null;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["access_logs"]["Row"], "id" | "created_at">;
        Update: never;
        Relationships: [];
      };
      interests: {
        Row: {
          id: number;
          email: string;
          name: string | null;
          source_path: string | null;
          interests: string[];
          resend_contact_id: string | null;
          member_id: number | null;
          created_at: string;
        };
        Insert: {
          email: string;
          name?: string | null;
          source_path?: string | null;
          interests?: string[];
          resend_contact_id?: string | null;
          member_id?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["interests"]["Insert"]>;
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: number;
          member_id: number;
          payment_rail: PaymentRail;
          wallet_id: number | null;
          stripe_subscription_id: string | null;
          stripe_customer_id: string | null;
          stripe_price_id: string | null;
          plan_key: PlanKey;
          monthly_cents: number;
          net_cents: number | null;
          status: StripeSubscriptionStatus;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          canceled_at: string | null;
          past_due_since: string | null;
          access_disabled_at: string | null;
          discount_cents: number | null;
          discount_duration: DiscountDuration | null;
          discount_months: number | null;
          discount_note: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          member_id: number;
          payment_rail?: PaymentRail;
          wallet_id?: number | null;
          stripe_subscription_id?: string | null;
          stripe_customer_id?: string | null;
          stripe_price_id?: string | null;
          plan_key: PlanKey;
          monthly_cents: number;
          net_cents?: number | null;
          status: StripeSubscriptionStatus;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          past_due_since?: string | null;
          access_disabled_at?: string | null;
          discount_cents?: number | null;
          discount_duration?: DiscountDuration | null;
          discount_months?: number | null;
          discount_note?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["subscriptions"]["Insert"]>;
        Relationships: [];
      };
      member_wallets: {
        Row: {
          id: number;
          member_id: number;
          chain_family: "evm";
          address: string;
          address_normalized: string;
          verification_method: "signature" | "admin_prior_payment";
          verified_at: string;
          verified_by: number | null;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          member_id: number;
          chain_family?: "evm";
          address: string;
          verification_method: "signature" | "admin_prior_payment";
          verified_at?: string;
          verified_by?: number | null;
          revoked_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["member_wallets"]["Insert"]>;
        Relationships: [];
      };
      wallet_verification_challenges: {
        Row: {
          id: number;
          member_id: number;
          address_normalized: string;
          nonce_hash: string;
          message: string;
          expires_at: string;
          consumed_at: string | null;
          created_at: string;
        };
        Insert: {
          member_id: number;
          address_normalized: string;
          nonce_hash: string;
          message: string;
          expires_at: string;
          consumed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["wallet_verification_challenges"]["Insert"]>;
        Relationships: [];
      };
      onchain_invoices: {
        Row: {
          id: number;
          subscription_id: number;
          member_id: number;
          period_start: string;
          period_end: string;
          due_at: string;
          base_amount_cents: number;
          discount_bps: number;
          amount_cents: number;
          amount_usdc_micros: number;
          chain_id: number;
          token_contract: string;
          treasury_address: string;
          status: OnchainInvoiceStatus;
          submitted_tx_hash: string | null;
          submitted_at: string | null;
          detected_at: string | null;
          paid_at: string | null;
          exception_reason: string | null;
          reminder_sent_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          subscription_id: number;
          member_id: number;
          period_start: string;
          period_end: string;
          due_at: string;
          base_amount_cents: number;
          discount_bps?: number;
          amount_cents: number;
          amount_usdc_micros: number;
          chain_id?: number;
          token_contract?: string;
          treasury_address?: string;
          status?: OnchainInvoiceStatus;
          submitted_tx_hash?: string | null;
          submitted_at?: string | null;
          detected_at?: string | null;
          paid_at?: string | null;
          exception_reason?: string | null;
          reminder_sent_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["onchain_invoices"]["Insert"]>;
        Relationships: [];
      };
      onchain_payments: {
        Row: {
          id: number;
          invoice_id: number;
          member_id: number;
          chain_id: number;
          tx_hash: string;
          log_index: number;
          block_number: number;
          block_hash: string;
          from_address: string;
          to_address: string;
          token_contract: string;
          amount_micros: number;
          chain_status: "included" | "safe" | "finalized" | "reorged";
          match_status: "credited" | "exception" | "rejected";
          exception_reason: string | null;
          observed_at: string;
          credited_at: string | null;
          effects_claimed_at: string | null;
          effects_completed_at: string | null;
          raw_log: unknown;
        };
        Insert: {
          invoice_id: number;
          member_id: number;
          chain_id: number;
          tx_hash: string;
          log_index: number;
          block_number: number;
          block_hash: string;
          from_address: string;
          to_address: string;
          token_contract: string;
          amount_micros: number;
          chain_status: "included" | "safe" | "finalized" | "reorged";
          match_status: "credited" | "exception" | "rejected";
          exception_reason?: string | null;
          credited_at?: string | null;
          effects_claimed_at?: string | null;
          effects_completed_at?: string | null;
          raw_log?: unknown;
        };
        Update: Partial<Database["public"]["Tables"]["onchain_payments"]["Insert"]>;
        Relationships: [];
      };
      onchain_relay_jobs: {
        Row: {
          invoice_id: number;
          member_id: number;
          wallet_id: number;
          from_address: string;
          token_contract: string;
          treasury_address: string;
          amount_usdc_micros: number;
          authorization_nonce: string;
          valid_after: number;
          valid_before: number;
          signature: string | null;
          status: "prepared" | "signed" | "submitting" | "submitted" | "expired";
          authorization_from_block: number;
          submitted_tx_hash: string | null;
          attempts: number;
          last_error: string | null;
          signed_at: string | null;
          submitted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          invoice_id: number;
          member_id: number;
          wallet_id: number;
          from_address: string;
          token_contract: string;
          treasury_address: string;
          amount_usdc_micros: number;
          authorization_nonce: string;
          valid_after: number;
          valid_before: number;
          signature?: string | null;
          status?: "prepared" | "signed" | "submitting" | "submitted" | "expired";
          authorization_from_block: number;
          submitted_tx_hash?: string | null;
          attempts?: number;
          last_error?: string | null;
          signed_at?: string | null;
          submitted_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["onchain_relay_jobs"]["Insert"]>;
        Relationships: [];
      };
      onchain_relay_worker: {
        Row: {
          singleton: boolean;
          lease_token: string | null;
          lease_claimed_at: string | null;
          updated_at: string;
        };
        Insert: {
          singleton?: boolean;
          lease_token?: string | null;
          lease_claimed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["onchain_relay_worker"]["Insert"]>;
        Relationships: [];
      };
      purchases: {
        Row: {
          id: number;
          member_id: number | null;
          stripe_checkout_session: string | null;
          stripe_payment_intent: string | null;
          kind: PurchaseKind;
          amount_cents: number;
          passes_granted: number;
          email: string | null;
          created_at: string;
        };
        Insert: {
          member_id?: number | null;
          stripe_checkout_session?: string | null;
          stripe_payment_intent?: string | null;
          kind: PurchaseKind;
          amount_cents: number;
          passes_granted: number;
          email?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["purchases"]["Insert"]>;
        Relationships: [];
      };
      pass_grants: {
        Row: {
          id: number;
          member_id: number;
          subscription_id: number | null;
          stripe_invoice_id: string | null;
          billing_event_key: string;
          plan_key: PlanKey;
          passes_granted: number;
          created_at: string;
        };
        Insert: {
          member_id: number;
          subscription_id?: number | null;
          stripe_invoice_id?: string | null;
          billing_event_key: string;
          plan_key: PlanKey;
          passes_granted: number;
        };
        Update: Partial<Database["public"]["Tables"]["pass_grants"]["Insert"]>;
        Relationships: [];
      };
      lock_sync_runs: {
        Row: {
          id: number;
          triggered_by: number | null;
          synced: number;
          failed: number;
          partial: number;
          // Per-member results returned by the lock-sync API. Schema:
          // { name, slot, action: "set"|"clear", ok: boolean, partial?: string[] }
          results: unknown;
          created_at: string;
        };
        Insert: {
          triggered_by?: number | null;
          synced: number;
          failed: number;
          partial: number;
          results?: unknown;
        };
        Update: Partial<Database["public"]["Tables"]["lock_sync_runs"]["Insert"]>;
        Relationships: [];
      };
      digest_notes: {
        Row: {
          id: number;
          note: string;
          author_member_id: number | null;
          created_at: string;
          consumed_at: string | null;
        };
        Insert: {
          note: string;
          author_member_id?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["digest_notes"]["Insert"]> & {
          consumed_at?: string | null;
        };
        Relationships: [];
      };
      admin_actions: {
        Row: {
          id: number;
          actor_member_id: number | null;
          action: string;
          target_table: string | null;
          target_id: string | null;
          idempotency_key: string | null;
          payload: Record<string, unknown>;
          created_at: string;
        };
        Insert: {
          actor_member_id?: number | null;
          action: string;
          target_table?: string | null;
          target_id?: string | null;
          idempotency_key?: string | null;
          payload?: Record<string, unknown>;
        };
        Update: Partial<Database["public"]["Tables"]["admin_actions"]["Insert"]>;
        Relationships: [];
      };
      webhook_events: {
        Row: {
          id: number;
          stripe_event_id: string;
          event_type: string;
          status: "processing" | "ok" | "data_error" | "error";
          error_message: string | null;
          member_id: number | null;
          duration_ms: number | null;
          received_at: string;
          completed_at: string | null;
        };
        Insert: {
          stripe_event_id: string;
          event_type: string;
          status?: "processing" | "ok" | "data_error" | "error";
          error_message?: string | null;
          member_id?: number | null;
          duration_ms?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["webhook_events"]["Insert"]> & {
          completed_at?: string | null;
          status?: "processing" | "ok" | "data_error" | "error";
          error_message?: string | null;
          duration_ms?: number | null;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      decrement_day_pass_balance: {
        Args: { p_member_id: number; p_amount?: number };
        Returns: number;
      };
      increment_day_pass_balance: {
        Args: { p_member_id: number; p_amount: number };
        Returns: number;
      };
      bind_member_wallet: {
        Args: {
          p_member_id: number;
          p_address: string;
          p_verification_method: "signature" | "admin_prior_payment";
          p_verified_by?: number | null;
        };
        Returns: number;
      };
      credit_onchain_invoice: {
        Args: {
          p_invoice_id: number;
          p_tx_hash: string;
          p_log_index: number;
          p_block_number: number;
          p_block_hash: string;
          p_from_address: string;
          p_to_address: string;
          p_token_contract: string;
          p_amount_micros: number;
          p_chain_status: string;
          p_raw_log?: unknown;
        };
        Returns: Array<{
          payment_id: number;
          member_id: number;
          subscription_id: number;
          plan_key: string;
          period_end: string;
          was_new: boolean;
        }>;
      };
    };
    CompositeTypes: { [_ in never]: never };
    Enums: {
      member_type: MemberType;
      access_method: AccessMethod;
    };
  };
}

// Convenience row types
export type Application = Database["public"]["Tables"]["applications"]["Row"];
export type Member = Database["public"]["Tables"]["members"]["Row"];
export type DayPass = Database["public"]["Tables"]["day_passes"]["Row"];
export type DayCode = Database["public"]["Tables"]["day_codes"]["Row"];
export type AccessLog = Database["public"]["Tables"]["access_logs"]["Row"];
export type Interest = Database["public"]["Tables"]["interests"]["Row"];
export type Subscription = Database["public"]["Tables"]["subscriptions"]["Row"];
export type MemberWallet = Database["public"]["Tables"]["member_wallets"]["Row"];
export type OnchainInvoice = Database["public"]["Tables"]["onchain_invoices"]["Row"];
export type OnchainPayment = Database["public"]["Tables"]["onchain_payments"]["Row"];
export type Purchase = Database["public"]["Tables"]["purchases"]["Row"];
export type PassGrant = Database["public"]["Tables"]["pass_grants"]["Row"];
export type WebhookEvent = Database["public"]["Tables"]["webhook_events"]["Row"];
export type LockSyncRun = Database["public"]["Tables"]["lock_sync_runs"]["Row"];

export interface LockSyncResultRow {
  name: string;
  slot: number;
  action: "set" | "clear";
  ok: boolean;
  partial?: string[];
}

export const INTEREST_OPTIONS = [
  { value: "membership", label: "Desk membership" },
  { value: "day_pass", label: "Day passes" },
  { value: "events", label: "Events & gatherings" },
  { value: "telegram", label: "Community Telegram" },
] as const;

export type InterestKey = (typeof INTEREST_OPTIONS)[number]["value"];
