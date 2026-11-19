// The server sends UTF-8 SSE with JSON data frames and heartbeat comments.
export function openEventStream(connect, { onEvent, resync, retryMs = 500, onError = () => {} }) {
  const controller = new AbortController()
  const { signal } = controller
  let timer
  let wake
  const retry = () => new Promise((resolve) => {
    wake = resolve
    timer = setTimeout(resolve, retryMs)
  })
  void (async () => {
    let reconnecting = false
    while (!signal.aborted) {
      let reader
      try {
        const response = await connect(signal)
        if (!response.ok || !response.body) throw Object.assign(new Error('会话事件流暂时不可用'), { status: response.status })
        reader = response.body.getReader()
        if (reconnecting) await resync()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let frame
          while ((frame = /\r?\n\r?\n/.exec(buffer))) {
            const data = buffer.slice(0, frame.index).split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
            buffer = buffer.slice(frame.index + frame[0].length)
            if (data && !signal.aborted) onEvent(JSON.parse(data))
          }
          if (buffer.length > 2 * 1024 * 1024) throw new Error('会话事件过大')
        }
      } catch (error) {
        if (signal.aborted || error.status === 401) break
        onError(error)
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
      reconnecting = true
      if (!signal.aborted) await retry()
    }
  })()
  return {
    close() {
      controller.abort()
      clearTimeout(timer)
      wake?.()
    }
  }
}
