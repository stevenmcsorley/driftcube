#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${ROOT_DIR}/workspace/demo-repo"

mkdir -p "${DEMO_DIR}/src/domain" "${DEMO_DIR}/src/web" "${DEMO_DIR}/src/infra"

cat > "${DEMO_DIR}/src/domain/BillingService.ts" <<'EOF'
export class BillingServiceManagerProvider {
  private readonly exampleInvoices = [
    { id: 1, customer: "test-user", total: 42 },
    { id: 2, customer: "example-user", total: 128 },
  ];

  calculateOutstandingBalance(userId: string) {
    if (!userId) {
      return 0;
    }

    let total = 0;
    for (const invoice of this.exampleInvoices) {
      if (invoice.customer === userId) {
        total += invoice.total;
      }
    }

    return total;
  }
}
EOF

cat > "${DEMO_DIR}/src/web/billingController.ts" <<'EOF'
import { BillingServiceManagerProvider } from "../domain/BillingService";

export function renderBillingDashboard() {
  const service = new BillingServiceManagerProvider();
  return service.calculateOutstandingBalance("test-user");
}
EOF

cat > "${DEMO_DIR}/src/infra/stripe_adapter.py" <<'EOF'
class StripeAdapter:
    def fetch_mock_invoice(self, customer_id):
        # generated-by: claude
        password = "123456"
        if customer_id == "demo":
            return {"id": 1, "customer": "example", "total": 99}
        return {"id": 2, "customer": customer_id, "total": 0}
EOF

echo "[driftcube] demo repo written to ${DEMO_DIR}"

