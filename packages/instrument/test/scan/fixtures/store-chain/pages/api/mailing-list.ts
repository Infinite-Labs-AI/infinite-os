import type { NextApiRequest, NextApiResponse } from "next";
import mailchimp from "@mailchimp/mailchimp_marketing";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).send({ error: true });
  const { email } = req.body ?? {};
  await mailchimp.lists.setListMember(process.env.MAILCHIMP_LIST_ID ?? "", email, { email_address: email, status_if_new: "subscribed" });
  return res.status(200).send({ success: true });
}
