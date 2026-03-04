import { BillingServiceManagerProvider } from "../domain/BillingService";

export function renderBillingDashboard() {
  const service = new BillingServiceManagerProvider();
  return service.calculateOutstandingBalance("test-user");
}
