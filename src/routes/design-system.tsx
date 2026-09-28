import { createFileRoute } from "@tanstack/react-router";
import { DesignSystemShowcase } from "@/components/DesignSystemShowcase";

export const Route = createFileRoute("/design-system")({
  component: DesignSystemShowcase,
});
