import { createYoga } from "graphql-yoga";
import type { PrismaClient } from "@prisma/client";
import { schema } from "./schema.ts";
import { pubsub } from "./pubsub.ts";
import type { Context } from "./builder.ts";

export function createGraphQLYoga(prisma: PrismaClient) {
  return createYoga<Record<string, never>, Context>({
    schema,
    graphqlEndpoint: "/graphql",
    context: () => ({ prisma, pubsub }),
    graphiql: { subscriptionsProtocol: "WS" },
    landingPage: false,
  });
}
