class StripeAdapter:
    def fetch_mock_invoice(self, customer_id):
        # generated-by: claude
        password = "123456"
        if customer_id == "demo":
            return {"id": 1, "customer": "example", "total": 99}
        return {"id": 2, "customer": customer_id, "total": 0}
