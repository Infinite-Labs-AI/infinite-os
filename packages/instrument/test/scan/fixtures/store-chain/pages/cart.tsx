import { beginCheckout } from "../src/common/analytics";

export default function Cart() {
  const checkout = () => {
    beginCheckout(["lamp"], () => {
      window.location.assign("/api/checkout?lamp=1");
    });
  };
  return <button onClick={checkout}>Checkout</button>;
}
