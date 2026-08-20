const response = await fetch("http://localhost:3000/orders/update", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    orderId: "ord_2048",
    customerName: "Mina",
    event: { type: "fulfillment_started", carrier: "Parcel Post" }
  })
});

if (!response.ok) throw new Error(`Order update request failed with HTTP ${response.status}`);
console.log(await response.json());

export {};
