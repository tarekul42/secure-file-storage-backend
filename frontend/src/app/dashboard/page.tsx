"use client";

import Dashboard from "../components/Dashboard";
import { RequireAuth } from "../components/RequireAuth";

export default function DashboardPage() {
  return (
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  );
}
