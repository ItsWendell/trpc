import { Readable } from 'node:stream';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AnyRouter, inferRouterContext } from '../../core';
import {
  getBatchStreamFormatter,
  HTTPBaseHandlerOptions,
  HTTPRequest,
} from '../../http';
import { HTTPResponse, ResponseChunk } from '../../http/internals/types';
import { resolveHTTPResponse } from '../../http/resolveHTTPResponse';
import { NodeHTTPCreateContextOption } from '../node-http';

export type FastifyHandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends FastifyRequest,
  TResponse extends FastifyReply,
> = HTTPBaseHandlerOptions<TRouter, TRequest> &
  NodeHTTPCreateContextOption<TRouter, TRequest, TResponse>;

type FastifyRequestHandlerOptions<
  TRouter extends AnyRouter,
  TRequest extends FastifyRequest,
  TResponse extends FastifyReply,
> = {
  req: TRequest;
  res: TResponse;
  path: string;
} & FastifyHandlerOptions<TRouter, TRequest, TResponse>;

export async function fastifyRequestHandler<
  TRouter extends AnyRouter,
  TRequest extends FastifyRequest,
  TResponse extends FastifyReply,
>(opts: FastifyRequestHandlerOptions<TRouter, TRequest, TResponse>) {
  const createContext = async function _createContext(): Promise<
    inferRouterContext<TRouter>
  > {
    return opts.createContext?.(opts);
  };

  const query = opts.req.query
    ? new URLSearchParams(opts.req.query as any)
    : new URLSearchParams(opts.req.url.split('?')[1]);

  const req: HTTPRequest = {
    query,
    method: opts.req.method,
    headers: opts.req.headers,
    body: opts.req.body ?? 'null',
  };

  let resolve: (value: FastifyReply) => void;
  const promise = new Promise<FastifyReply>((r) => (resolve = r));

  const unstable_onHead = (head: HTTPResponse) => {
    if (!opts.res.statusCode || opts.res.statusCode === 200) {
      opts.res.statusCode = head.status;
    }
    for (const [key, value] of Object.entries(head.headers ?? {})) {
      /* istanbul ignore if -- @preserve */
      if (typeof value === 'undefined') {
        continue;
      }
      void opts.res.header(key, value);
    }
  };

  let isStream = false;
  let stream: Readable;
  const formatter = getBatchStreamFormatter();
  const unstable_onChunk = ([index, string]: ResponseChunk) => {
    if (index === -1) {
      // full response, no streaming
      resolve(opts.res.send(string));
      return;
    }
    if (!isStream) {
      void opts.res.header('Transfer-Encoding', 'chunked');
      void opts.res.header(
        'Vary',
        opts.res.hasHeader('Vary')
          ? 'trpc-batch-mode, ' + opts.res.getHeader('Vary')
          : 'trpc-batch-mode',
      );
      stream = new Readable();
      stream._read = () => {}; // eslint-disable-line @typescript-eslint/no-empty-function -- https://github.com/fastify/fastify/issues/805#issuecomment-369172154
      resolve(opts.res.send(stream));
      isStream = true;
    }
    stream.push(formatter(index, string));
  };

  resolveHTTPResponse({
    req,
    createContext,
    path: opts.path,
    router: opts.router,
    batching: opts.batching,
    responseMeta: opts.responseMeta,
    onError(o) {
      opts?.onError?.({ ...o, req: opts.req });
    },
    unstable_onHead,
    unstable_onChunk,
  })
    .then(() => {
      if (isStream) {
        stream.push(formatter.end());
        stream.push(null); // https://github.com/fastify/fastify/issues/805#issuecomment-369172154
      }
    })
    .catch(() => {
      if (isStream) {
        stream.push(null);
      }
    });

  return promise;
}
