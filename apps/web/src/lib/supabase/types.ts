export type MemberType = "full" | "daypass";
export type ApplicationStatus = "pending" | "approved" | "rejected";
export type MembershipInterest = "daypass_single" | "daypass_5pack" | "hot_desk" | "reserved_desk";
export type MembershipTier = "community" | "coworking" | "cooperative";
export type AccessMethod = "nfc" | "pin" | "daycode";

export interface Database {
  public: {
    Tables: {
      applications: {
        Row: {
          id: number;
          supabase_user_id: string | null;
          email: string;
          name: string;
          about: string | null;
          why_join: string | null;
          membership_interest: MembershipInterest;
          status: ApplicationStatus;
          admin_notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          supabase_user_id?: string | null;
          email: string;
          name: string;
          about?: string | null;
          why_join?: string | null;
          membership_interest?: MembershipInterest;
          status?: ApplicationStatus;
          admin_notes?: string | null;
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
          nfc_key_address: string | null;
          pin_code: string | null;
          pin_code_slot: number | null;
          member_type: MemberType;
          membership_tier: MembershipTier;
          is_admin: boolean;
          disabled: boolean;
          bio: string | null;
          skills: string[] | null;
          profile_photo_url: string | null;
          show_in_directory: boolean;
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
          nfc_key_address?: string | null;
          pin_code?: string | null;
          pin_code_slot?: number | null;
          member_type: MemberType;
          membership_tier: MembershipTier;
          is_admin?: boolean;
          disabled?: boolean;
          bio?: string | null;
          skills?: string[] | null;
          profile_photo_url?: string | null;
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
          expires_at: string;
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
          expires_at: string;
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
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
    Enums: {
      member_type: MemberType;
      membership_tier: MembershipTier;
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
