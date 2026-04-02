/**
 * DoorDash Drive API — create delivery request shape (v2).
 * @see https://developer.doordash.com/en-US/docs/drive/tutorials/get_started/#create-a-delivery
 */
export interface DoorDashCreateDeliveryRequest {
  external_delivery_id: string;
  pickup_address: string;
  pickup_business_name: string;
  pickup_phone_number: string;
  pickup_instructions?: string;
  dropoff_address: string;
  dropoff_business_name: string;
  dropoff_phone_number: string;
  dropoff_instructions?: string;
  /** Order value in cents (e.g. 1999 = $19.99). */
  order_value: number;
}

/** Subset of fields we surface back to the model; API may return more. */
export interface DoorDashDeliverySummary {
  external_delivery_id?: string;
  delivery_status?: string;
  tracking_url?: string;
  [key: string]: unknown;
}
