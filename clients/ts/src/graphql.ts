import type { createCustomersClient } from './client.js'

/**
 * GraphQL read module for the customers capability — the root `Customer` type + its
 * queries. Other capabilities `extend type Customer` with their edges. The read-gateway
 * composes this with the other `@baseworks/*` `/graphql` modules. Context is structural
 * (satisfied by the gateway's per-request context); this module has no `graphql` dep.
 */
export interface CustomersGraphContext {
  customers: ReturnType<typeof createCustomersClient>
}

export const typeDefs = /* GraphQL */ `
  type Query
  type Customer {
    id: ID!
    shortId: String!
    externalId: String
    name: String
    email: String
    phone: String
    currency: String
    createdAt: Float!
  }
  extend type Query {
    customer(ref: String!): Customer
    customers(limit: Int, offset: Int): [Customer!]!
  }
`

export const resolvers = {
  Query: {
    customer: (_: unknown, { ref }: { ref: string }, ctx: CustomersGraphContext) => ctx.customers.get(ref).catch(() => null),
    customers: (_: unknown, args: { limit?: number; offset?: number }, ctx: CustomersGraphContext) => ctx.customers.list(args),
  },
}
