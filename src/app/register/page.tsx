"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import AuthForm from "../components/AuthForm";
import { useAuth } from "@/lib/auth";

export default function RegisterPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  return <AuthForm mode="register" />;
}
