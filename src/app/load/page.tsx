"use client";

import { useRouter } from "next/navigation";
import { LoadExisting } from "@/components/flow/load-existing";

export default function LoadPage() {
  const router = useRouter();

  return (
    <LoadExisting
      onLoaded={(projectId) => router.push(`/project/${projectId}`)}
    />
  );
}
