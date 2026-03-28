import { argv, exit, stdin } from 'node:process'
import { Buffer } from 'node:buffer'

import { Format, LogLevel, LogLevelString, useLogg } from '@guiiai/logg'
import { Client } from '@proj-airi/server-sdk'
import { cac } from 'cac'

import { name, version } from '../package.json'

const logger = useLogg(name).withLogLevel(LogLevel.Log).withFormat(Format.Pretty)

async function readStdin(): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stdin) {
    chunks.push((chunk as Buffer).toString('utf-8'))
  }
  return chunks.join('')
}

async function makeClient(url?: string, token?: string) {
  const client = new Client({
    name: 'proj-airi:plugin-openclaw',
    autoConnect: false,
    url,
    token,
  })
  await client.connect({ timeout: 15_000 })
  return client
}

const cli = cac('airi-plugin-openclaw')
cli.help().version(version)

cli
  .command('send [text]', 'Send text into AIRI as input:text')
  .option('--url <url>', 'AIRI websocket url')
  .option('--token <token>', 'AIRI websocket token')
  .option('-l, --logLevel <level>', 'Set log level: info, warn, error, silent', { default: 'info' })
  .action(async (text, flags) => {
    logger.withLogLevelString((flags.logLevel ?? 'info') as LogLevelString.Log)

    let payload = text?.trim() ?? ''
    if (!payload && !stdin.isTTY) {
      payload = (await readStdin()).trim()
    }
    if (!payload) {
      throw new Error('No text provided. Pass text argument or pipe stdin.')
    }

    const client = await makeClient(flags.url, flags.token)
    client.sendOrThrow({
      type: 'input:text',
      data: { text: payload },
    })
    logger.success('Sent text to AIRI')
    await client.close()
  })

cli
  .command('listen', 'Listen for AIRI chat output events')
  .option('--url <url>', 'AIRI websocket url')
  .option('--token <token>', 'AIRI websocket token')
  .option('-l, --logLevel <level>', 'Set log level: info, warn, error, silent', { default: 'info' })
  .action(async (flags) => {
    logger.withLogLevelString((flags.logLevel ?? 'info') as LogLevelString.Log)

    const client = await makeClient(flags.url, flags.token)
    client.onEvent('output:gen-ai:chat:message', (event) => {
      console.log(JSON.stringify({ type: event.type, data: event.data }, null, 2))
    })
    client.onEvent('output:gen-ai:chat:complete', (event) => {
      console.log(JSON.stringify({ type: event.type, data: event.data }, null, 2))
    })
    logger.info('Listening for AIRI output events... Press Ctrl+C to exit.')
    await new Promise(() => {})
  })

export async function runCLI(): Promise<void> {
  try {
    await cli.parse(argv, { run: false })
    await cli.runMatchedCommand()
  }
  catch (error) {
    logger.withError(error).error('OpenClaw AIRI bridge failed')
    exit(1)
  }
}
