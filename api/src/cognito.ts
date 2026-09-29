// Thin, typed layer over the Cognito admin APIs used by the admin app.
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  CreateGroupCommand,
  ListGroupsCommand,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type AttributeType,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider'

export type AdminUser = {
  username: string
  email: string
  name: string
  status: string
  enabled: boolean
  created: string
  updated: string
  groups: string[]
}

export class Cognito {
  private client: CognitoIdentityProviderClient
  private poolId: string

  constructor(region: string, poolId: string) {
    this.client = new CognitoIdentityProviderClient({ region })
    this.poolId = poolId
  }

  private static attr(attrs: AttributeType[] | undefined, name: string): string {
    return attrs?.find((a) => a.Name === name)?.Value ?? ''
  }

  private static toUser(u: UserType, groups: string[]): AdminUser {
    return {
      username: u.Username ?? '',
      email: Cognito.attr(u.Attributes, 'email'),
      name: Cognito.attr(u.Attributes, 'name'),
      status: u.UserStatus ?? 'UNKNOWN',
      enabled: u.Enabled ?? false,
      created: u.UserCreateDate?.toISOString() ?? '',
      updated: u.UserLastModifiedDate?.toISOString() ?? '',
      groups,
    }
  }

  /** Every user in the pool with their group memberships (pools here are small: tens of users). */
  async listUsers(): Promise<AdminUser[]> {
    const users: UserType[] = []
    let token: string | undefined
    do {
      const r = await this.client.send(new ListUsersCommand({ UserPoolId: this.poolId, Limit: 60, PaginationToken: token }))
      users.push(...(r.Users ?? []))
      token = r.PaginationToken
    } while (token)

    const membership = new Map<string, string[]>()
    for (const g of await this.listGroups()) {
      for (const username of await this.usersInGroup(g)) {
        membership.set(username, [...(membership.get(username) ?? []), g])
      }
    }
    return users
      .map((u) => Cognito.toUser(u, (membership.get(u.Username ?? '') ?? []).sort()))
      .sort((a, b) => (a.email || a.username).localeCompare(b.email || b.username))
  }

  async getUser(username: string): Promise<AdminUser> {
    const r = await this.client.send(new AdminGetUserCommand({ UserPoolId: this.poolId, Username: username }))
    const groups: string[] = []
    for (const g of await this.listGroups()) if ((await this.usersInGroup(g)).includes(username)) groups.push(g)
    return Cognito.toUser(
      { Username: r.Username, Attributes: r.UserAttributes, UserStatus: r.UserStatus, Enabled: r.Enabled, UserCreateDate: r.UserCreateDate, UserLastModifiedDate: r.UserLastModifiedDate },
      groups.sort(),
    )
  }

  async listGroups(): Promise<string[]> {
    const out: string[] = []
    let token: string | undefined
    do {
      const r = await this.client.send(new ListGroupsCommand({ UserPoolId: this.poolId, Limit: 60, NextToken: token }))
      out.push(...(r.Groups ?? []).map((g) => g.GroupName ?? '').filter(Boolean))
      token = r.NextToken
    } while (token)
    return out
  }

  async ensureGroups(names: string[], descriptions: Record<string, string> = {}): Promise<string[]> {
    const existing = new Set(await this.listGroups())
    const created: string[] = []
    for (const g of names) {
      if (existing.has(g)) continue
      await this.client.send(new CreateGroupCommand({ UserPoolId: this.poolId, GroupName: g, Description: descriptions[g] }))
      created.push(g)
    }
    return created
  }

  private async usersInGroup(group: string): Promise<string[]> {
    const out: string[] = []
    let token: string | undefined
    do {
      const r = await this.client.send(new ListUsersInGroupCommand({ UserPoolId: this.poolId, GroupName: group, Limit: 60, NextToken: token }))
      out.push(...(r.Users ?? []).map((u) => u.Username ?? '').filter(Boolean))
      token = r.NextToken
    } while (token)
    return out
  }

  /** Invite by email. Cognito emails a temporary password; the user sets their own at first sign-in. */
  async createUser(email: string, name?: string): Promise<string> {
    const attrs: AttributeType[] = [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ]
    if (name) attrs.push({ Name: 'name', Value: name })
    const r = await this.client.send(
      new AdminCreateUserCommand({ UserPoolId: this.poolId, Username: email, UserAttributes: attrs, DesiredDeliveryMediums: ['EMAIL'] }),
    )
    return r.User?.Username ?? email
  }

  /** Re-send the invitation email with a fresh temporary password (only valid while FORCE_CHANGE_PASSWORD). */
  async resendInvite(username: string): Promise<void> {
    await this.client.send(
      new AdminCreateUserCommand({ UserPoolId: this.poolId, Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }),
    )
  }

  async setEnabled(username: string, enabled: boolean): Promise<void> {
    const Cmd = enabled ? AdminEnableUserCommand : AdminDisableUserCommand
    await this.client.send(new Cmd({ UserPoolId: this.poolId, Username: username }))
    if (!enabled) await this.globalSignOut(username)
  }

  async deleteUser(username: string): Promise<void> {
    await this.client.send(new AdminDeleteUserCommand({ UserPoolId: this.poolId, Username: username }))
  }

  /** Emails a verification code; the user picks a new password at next sign-in. */
  async resetPassword(username: string): Promise<void> {
    await this.client.send(new AdminResetUserPasswordCommand({ UserPoolId: this.poolId, Username: username }))
    await this.globalSignOut(username)
  }

  /**
   * Clear the user's TOTP preference and end their sessions. The pool requires MFA, so the hosted
   * UI walks them through registering a new authenticator at their next sign-in.
   */
  async resetMfa(username: string): Promise<void> {
    await this.client.send(
      new AdminSetUserMFAPreferenceCommand({
        UserPoolId: this.poolId,
        Username: username,
        SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
      }),
    )
    await this.globalSignOut(username)
  }

  async globalSignOut(username: string): Promise<void> {
    try {
      await this.client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.poolId, Username: username }))
    } catch {
      // Users who never signed in have no sessions to revoke.
    }
  }

  async updateName(username: string, name: string): Promise<void> {
    await this.client.send(
      new AdminUpdateUserAttributesCommand({ UserPoolId: this.poolId, Username: username, UserAttributes: [{ Name: 'name', Value: name }] }),
    )
  }

  /** Make the user's group memberships equal `wanted` (only touching groups in `managed`). */
  async setGroups(username: string, current: string[], wanted: string[], managed: string[]): Promise<{ added: string[]; removed: string[] }> {
    const { added, removed } = diffGroups(current, wanted, managed)
    for (const g of added) await this.client.send(new AdminAddUserToGroupCommand({ UserPoolId: this.poolId, Username: username, GroupName: g }))
    for (const g of removed) await this.client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.poolId, Username: username, GroupName: g }))
    return { added, removed }
  }
}

/** Pure helper: which managed groups to add/remove to move `current` to `wanted`. */
export function diffGroups(current: string[], wanted: string[], managed: string[]): { added: string[]; removed: string[] } {
  const m = new Set(managed)
  const cur = new Set(current.filter((g) => m.has(g)))
  const want = new Set(wanted.filter((g) => m.has(g)))
  return {
    added: [...want].filter((g) => !cur.has(g)).sort(),
    removed: [...cur].filter((g) => !want.has(g)).sort(),
  }
}
