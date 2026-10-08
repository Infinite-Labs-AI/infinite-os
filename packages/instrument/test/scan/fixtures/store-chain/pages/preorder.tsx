import { useEffect } from "react";
import { addToCartEvent } from "../src/common/analytics";

// Ad landing link: adds the lamp to the cart on load, then opens the cart.
export default function Preorder() {
  useEffect(() => {
    addToCartEvent("lamp");
    window.location.replace("/cart");
  }, []);
  return null;
}
