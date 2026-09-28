import { createFileRoute } from "@tanstack/react-router";
import { DesignSystemShowcase } from "@/components/DesignSystemShowcase";

// @ts-expect-error - dynamic route tree generation
export const Route = createFileRoute("/design-system")({
  component: DesignSystemShowcase,
});
