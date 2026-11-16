import { checkAccess } from "../lib/access.js";

export async function onRequest(context) {
  return (await checkAccess(context.request, context.env)) || context.next();
}
