import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "./supabase";

/**
 * Sends a signed-out visitor to sign in. Without it, a client screen opened
 * with no session rendered an empty "Client" shell and a row of silently
 * failing queries instead of saying why nothing was there.
 */
export function useRequireSession(): void {
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    void supabase()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled && !data.user) void navigate({ to: "/auth" });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);
}
