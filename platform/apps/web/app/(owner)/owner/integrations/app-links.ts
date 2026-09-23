import type { AppActionKind } from "@aura/shared";

/**
 * Where each of the store's buttons goes. One table, so a tile's "Fix" and the
 * app page's "Fix" can never lead to different places.
 *
 * Starting or finishing a connection goes to the connect route; everything
 * else goes to the app page, at the section that answers it.
 */
export const appHref = (id: string) => `/owner/integrations/${id}`;
export const connectHref = (id: string) => `/owner/integrations/${id}/connect`;

export function actionHref(id: string, kind: AppActionKind): string {
  switch (kind) {
    case "connect":
    case "finish":
      return connectHref(id);
    case "fix":
    case "resume":
      return `${appHref(id)}#connections`;
    case "add_sign_in_app":
      return `${appHref(id)}#sign-in-app`;
    case "ask_provider":
    case "ask_owner":
      return `${appHref(id)}#get-it`;
    case "open":
      return appHref(id);
  }
}
