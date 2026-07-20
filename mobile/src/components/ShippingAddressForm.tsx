// Moved to @just-messin-around/expo-foundation/ui as AddressForm (sectionLabel
// defaults to "Shipping address"). Re-exported here so existing imports
// (`../components/ShippingAddressForm`) keep working unchanged.
export {
  AddressForm as default,
  EMPTY_ADDRESS,
  isAddressValid,
} from '@just-messin-around/expo-foundation/ui';
export type { ShippingAddress } from '@just-messin-around/expo-foundation/ui';
