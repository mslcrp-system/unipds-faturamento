"use client";
import { useEffect, useState } from "react";
import { TENANTS } from "@/lib/tenants";

export function useActiveTenant() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  useEffect(() => {
    const stored = localStorage.getItem("active_tenant");
    setTenantId(stored ?? TENANTS[0].id);
  }, []);
  return tenantId;
}
