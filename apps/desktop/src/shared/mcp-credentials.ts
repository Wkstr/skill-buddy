/**
 * 指向凭据的位置或标识、而非凭据本身的名称后缀。
 *
 * 需要先于 {@link MCP_CREDENTIAL_NAME} 判断：`SSH_PRIVATE_KEY_PATH` 是文件路径，
 * `ACCESS_KEY_ID` 是公开标识符，都不应该弹出明文填写框。
 */
const NON_CREDENTIAL_SUFFIX =
  /_(?:PATH|FILE|DIR|ID|NAME|PREFIX|SUFFIX|TYPE|FORMAT|ALGORITHM|ENABLED|TIMEOUT|EXPIRY|TTL|VERSION)$/i

const MCP_CREDENTIAL_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|APIKEY|API_?KEY|AUTHORIZATION|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY|DATABASE_?URL|DB_?URL|REDIS_?URL|MONGODB_?URI|MONGO_?URI|CONNECTION_?STRING|CLIENT_?SECRET|SESSION_?KEY|COOKIE|BEARER|DSN|PAT)(?:$|_)/i

/**
 * 判断环境变量名称是否表示需要用户提供的凭据，而非普通运行时配置。
 *
 * 判定偏宽松：漏判会让真实凭据既拿不到填写入口、又被主进程校验硬拒绝；
 * 误判只是多给一个用不上的输入框，代价小得多。
 */
export function isMcpCredentialName(name: string): boolean {
  if (NON_CREDENTIAL_SUFFIX.test(name)) return false
  return MCP_CREDENTIAL_NAME.test(name)
}
