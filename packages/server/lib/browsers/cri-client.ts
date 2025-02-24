import debugModule from 'debug'
import _ from 'lodash'

const chromeRemoteInterface = require('chrome-remote-interface')
const errors = require('../errors')

const debug = debugModule('cypress:server:browsers:cri-client')
// debug using cypress-verbose:server:browsers:cri-client:send:*
const debugVerboseSend = debugModule('cypress-verbose:server:browsers:cri-client:send:[-->]')
// debug using cypress-verbose:server:browsers:cri-client:recv:*
const debugVerboseReceive = debugModule('cypress-verbose:server:browsers:cri-client:recv:[<--]')

const WEBSOCKET_NOT_OPEN_RE = /^WebSocket is (?:not open|already in CLOSING or CLOSED state)/

/**
 * Url returned by the Chrome Remote Interface
*/
type websocketUrl = string

/**
 * Enumerations to make programming CDP slightly simpler - provides
 * IntelliSense whenever you use named types.
 */
namespace CRI {
  export type Command =
    'Page.enable' |
    'Network.enable' |
    'Console.enable' |
    'Browser.getVersion' |
    'Page.bringToFront' |
    'Page.captureScreenshot' |
    'Page.navigate' |
    'Page.startScreencast' |
    'Page.screencastFrameAck' |
    'Page.setDownloadBehavior' |
    string

  export type EventName =
    'Page.screencastFrame' |
    'Page.downloadWillBegin' |
    'Page.downloadProgress' |
    string
}

/**
 * Wrapper for Chrome Remote Interface client. Only allows "send" method.
 * @see https://github.com/cyrus-and/chrome-remote-interface#clientsendmethod-params-callback
*/
interface CRIWrapper {
  /**
   * Get the `protocolVersion` supported by the browser.
   */
  getProtocolVersion (): Promise<Version>
  /**
   * Rejects if `protocolVersion` is less than the current version.
   * @param protocolVersion CDP version string (ex: 1.3)
   */
  ensureMinimumProtocolVersion(protocolVersion: string): Promise<void>
  /**
   * Sends a command to the Chrome remote interface.
   * @example client.send('Page.navigate', { url })
  */
  send (command: CRI.Command, params?: object): Promise<any>
  /**
   * Registers callback for particular event.
   * @see https://github.com/cyrus-and/chrome-remote-interface#class-cdp
   */
  on (eventName: CRI.EventName, cb: Function): void
  /**
   * Calls underlying remote interface client close
  */
  close (): Promise<void>
}

interface Version {
  major: number
  minor: number
}

const isVersionGte = (a: Version, b: Version) => {
  return a.major > b.major || (a.major === b.major && a.minor >= b.minor)
}

const getMajorMinorVersion = (version: string): Version => {
  const [major, minor] = version.split('.', 2).map(Number)

  return { major, minor }
}

const maybeDebugCdpMessages = (cri) => {
  if (debugVerboseReceive.enabled) {
    cri._ws.on('message', (data) => {
      data = _
      .chain(JSON.parse(data))
      .tap((data) => {
        ([
          'params.data', // screencast frame data
          'result.data', // screenshot data
        ]).forEach((truncatablePath) => {
          const str = _.get(data, truncatablePath)

          if (!_.isString(str)) {
            return
          }

          _.set(data, truncatablePath, _.truncate(str, {
            length: 100,
            omission: `... [truncated string of total bytes: ${str.length}]`,
          }))
        })

        return data
      })
      .value()

      debugVerboseReceive('received CDP message %o', data)
    })
  }

  if (debugVerboseSend.enabled) {
    const send = cri._ws.send

    cri._ws.send = (data, callback) => {
      debugVerboseSend('sending CDP command %o', JSON.parse(data))

      return send.call(cri._ws, data, callback)
    }
  }
}

/**
 * Creates a wrapper for Chrome remote interface client
 * that only allows to use low-level "send" method
 * and not via domain objects and commands.
 *
 * @example create('ws://localhost:...').send('Page.bringToFront')
 */
export { chromeRemoteInterface }

type DeferredPromise = { resolve: Function, reject: Function }

interface CriClientOptions {
  target: websocketUrl
  onError: Function
  onReconnect?: (client: CRIWrapper) => void
}

export const create = async (options: CriClientOptions): Promise<CRIWrapper> => {
  const { target, onError, onReconnect } = options
  const subscriptions: {eventName: CRI.EventName, cb: Function}[] = []
  const enableCommands: CRI.Command[] = []
  let enqueuedCommands: {command: CRI.Command, params: any, p: DeferredPromise }[] = []

  let closed = false // has the user called .close on this?
  let connected = false // is this currently connected to CDP?

  let cri
  let client: CRIWrapper

  const reconnect = async () => {
    debug('disconnected, attempting to reconnect... %o', { closed })

    connected = false

    if (closed) {
      return
    }

    try {
      await connect()

      debug('restoring subscriptions + running *.enable and queued commands... %o', { subscriptions, enableCommands, enqueuedCommands })

      // '*.enable' commands need to be resent on reconnect or any events in
      // that namespace will no longer be received
      await Promise.all(enableCommands.map((cmdName) => {
        return cri.send(cmdName)
      }))

      subscriptions.forEach((sub) => {
        cri.on(sub.eventName, sub.cb)
      })

      enqueuedCommands.forEach((cmd) => {
        cri.send(cmd.command, cmd.params)
        .then(cmd.p.resolve, cmd.p.reject)
      })

      enqueuedCommands = []

      if (onReconnect) {
        onReconnect(client)
      }
    } catch (err) {
      onError(errors.get('CDP_COULD_NOT_RECONNECT', err))
    }
  }

  const connect = async () => {
    await cri?.close()

    debug('connecting %o', { target })

    cri = await chromeRemoteInterface({
      target,
      local: true,
      // Minor optimization. chrome-remote-interface creates a DSL based on
      // this so you can call methods instead of using the event emitter
      // (e.g. cri.Network.enable() instead of cri.send('Network.enable'))
      // We only use the event emitter, so if we pass in an empty protcol,
      // it will keep c-r-i from looping through it and needlessly creating
      // the DSL
      protocol: { domains: [] },
    })

    connected = true

    maybeDebugCdpMessages(cri)

    // @see https://github.com/cyrus-and/chrome-remote-interface/issues/72
    cri._notifier.on('disconnect', reconnect)
  }

  await connect()

  const ensureMinimumProtocolVersion = async (protocolVersion: string) => {
    const actual = await getProtocolVersion()
    const minimum = getMajorMinorVersion(protocolVersion)

    if (!isVersionGte(actual, minimum)) {
      errors.throw('CDP_VERSION_TOO_OLD', protocolVersion, actual)
    }
  }

  const getProtocolVersion = _.memoize(async () => {
    let version

    try {
      version = await client.send('Browser.getVersion')
    } catch (_) {
      // could be any version <= 1.2
      version = { protocolVersion: '0.0' }
    }

    return getMajorMinorVersion(version.protocolVersion)
  })

  client = {
    ensureMinimumProtocolVersion,
    getProtocolVersion,
    async send (command: CRI.Command, params?: object) {
      const enqueue = () => {
        return new Promise((resolve, reject) => {
          enqueuedCommands.push({ command, params, p: { resolve, reject } })
        })
      }

      // Keep track of '*.enable' commands so they can be resent when
      // reconnecting
      if (command.endsWith('.enable')) {
        enableCommands.push(command)
      }

      if (connected) {
        try {
          return await cri.send(command, params)
        } catch (err) {
          // This error occurs when the browser has been left open for a long
          // time and/or the user's computer has been put to sleep. The
          // socket disconnects and we need to recreate the socket and
          // connection
          if (!WEBSOCKET_NOT_OPEN_RE.test(err.message)) {
            throw err
          }

          debug('encountered closed websocket on send %o', { command, params, err })

          const p = enqueue()

          reconnect()

          return p
        }
      }

      return enqueue()
    },
    on (eventName: CRI.EventName, cb: Function) {
      subscriptions.push({ eventName, cb })
      debug('registering CDP on event %o', { eventName })

      return cri.on(eventName, cb)
    },
    close () {
      closed = true

      return cri.close()
    },
  }

  return client
}
