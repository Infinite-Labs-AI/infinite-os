import { useRouter } from "next/router";
import { addToCartEvent } from "../src/common/analytics";

export default function Home() {
  const router = useRouter();
  const buyOne = () => {
    addToCartEvent("lamp");
    window.location.assign("/cart");
  };
  const buyPair = () => {
    addToCartEvent("lamp-pair");
    void router.push("/cart");
  };
  return (
    <main>
      <button onClick={buyOne}>Buy one</button>
      <button onClick={buyPair}>Buy two</button>
    </main>
  );
}
