import WebSocket from 'ws'

namespace Protocol {
  export type ByteArray = any; // You can replace 'any' with appropriate types

  const PKG_HEAD_BYTES: number = 4;
  const MSG_FLAG_BYTES: number = 1;
  const MSG_ROUTE_CODE_BYTES: number = 2;
  const MSG_ID_MAX_BYTES: number = 5;
  const MSG_ROUTE_LEN_BYTES: number = 1;
  const MSG_ROUTE_CODE_MAX: number = 0xffff;

  export const MSG_COMPRESS_ROUTE_MASK: number = 0x1;
  export const MSG_TYPE_MASK: number = 0x7;

  export function strencode(str: string) {
    var byteArray = Buffer.alloc(str.length * 3);
    var offset = 0;
    for (var i = 0; i < str.length; i++) {
      var charCode = str.charCodeAt(i);
      var codes = null;
      if (charCode <= 0x7f) {
        codes = [charCode];
      } else if (charCode <= 0x7ff) {
        codes = [0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f)];
      } else {
        codes = [0xe0 | (charCode >> 12), 0x80 | ((charCode & 0xfc0) >> 6), 0x80 | (charCode & 0x3f)];
      }
      for (var j = 0; j < codes.length; j++) {
        byteArray[offset] = codes[j];
        ++offset;
      }
    }
    var _buffer = Buffer.alloc(offset);
    copyArray(_buffer, 0, byteArray, 0, offset);
    return _buffer;
  }

  export function strdecode(buffer): string {
    var bytes = Buffer.from(buffer);
    var array = [];
    var offset = 0;
    var charCode = 0;
    var end = bytes.length;
    while (offset < end) {
      if (bytes[offset] < 128) {
        charCode = bytes[offset];
        offset += 1;
      } else if (bytes[offset] < 224) {
        charCode = ((bytes[offset] & 0x3f) << 6) + (bytes[offset + 1] & 0x3f);
        offset += 2;
      } else {
        charCode = ((bytes[offset] & 0x0f) << 12) + ((bytes[offset + 1] & 0x3f) << 6) + (bytes[offset + 2] & 0x3f);
        offset += 3;
      }
      array.push(charCode);
    }
    var res = '';
    var chunk = 8 * 1024;
    var i;
    for (i = 0; i < array.length / chunk; i++) {
      res += String.fromCharCode.apply(null, array.slice(i * chunk, (i + 1) * chunk));
    }
    res += String.fromCharCode.apply(null, array.slice(i * chunk));
    return res;
  }

  export namespace Package {
    export const TYPE_HANDSHAKE = 1
    export const TYPE_HANDSHAKE_ACK = 2
    export const TYPE_HEARTBEAT = 3
    export const TYPE_DATA = 4
    export const TYPE_KICK = 5

    export function encode(type: number, body: Uint8Array | undefined = undefined): Uint8Array {
      var length = body ? body.length : 0;
      var buffer = Buffer.alloc(PKG_HEAD_BYTES + length);
      var index = 0;
      buffer[index++] = type & 0xff;
      buffer[index++] = (length >> 16) & 0xff;
      buffer[index++] = (length >> 8) & 0xff;
      buffer[index++] = length & 0xff;
      if (body) {
        copyArray(buffer, index, body, 0, length);
      }
      return buffer;
    }

    export function decode(buffer) {
      var bytes = Buffer.from(buffer);
      var type = bytes[0];
      var index = 1;
      var length = ((bytes[index++]) << 16 | (bytes[index++]) << 8 | bytes[index++]) >>> 0;
      var body = length ? Buffer.alloc(length) : null;
      copyArray(body, 0, bytes, PKG_HEAD_BYTES, length);
      return { 'type': type, 'body': body };
    }
  }

  export namespace Message {
    export const TYPE_REQUEST = 0
    export const TYPE_NOTIFY = 1
    export const TYPE_RESPONSE = 2
    export const TYPE_PUSH = 3


    export function encode(id, type, compressRoute, route, msg) {
      var idBytes = msgHasId(type) ? caculateMsgIdBytes(id) : 0;
      var msgLen = MSG_FLAG_BYTES + idBytes;

      if (msgHasRoute(type)) {
        if (compressRoute) {
          if (typeof route !== 'number') {
            throw new Error('error flag for number route!');
          }
          msgLen += MSG_ROUTE_CODE_BYTES;
        } else {
          msgLen += MSG_ROUTE_LEN_BYTES;
          if (route) {
            route = Protocol.strencode(route);
            if (route.length > 255) {
              throw new Error('route maxlength is overflow');
            }
            msgLen += route.length;
          }
        }
      }

      if (msg) {
        msgLen += msg.length;
      }

      var buffer = Buffer.alloc(msgLen);
      var offset = 0;

      // add flag
      offset = encodeMsgFlag(type, compressRoute, buffer, offset);

      // add message id
      if (msgHasId(type)) {
        offset = encodeMsgId(id, idBytes, buffer, offset);
      }

      // add route
      if (msgHasRoute(type)) {
        offset = encodeMsgRoute(compressRoute, route, buffer, offset);
      }

      // add body
      if (msg) {
        offset = encodeMsgBody(msg, buffer, offset);
      }

      return buffer;
    }

    export function decode(buffer) {
      var bytes = Buffer.from(buffer);
      var bytesLen = bytes.length || bytes.byteLength;
      var offset = 0;
      var id = 0;
      var route = null;

      // parse flag
      var flag = bytes[offset++];
      var compressRoute = flag & MSG_COMPRESS_ROUTE_MASK;
      var type = (flag >> 1) & MSG_TYPE_MASK;

      // parse id
      if (msgHasId(type)) {
        var byte = bytes[offset++];
        id = byte & 0x7f;
        while (byte & 0x80) {
          id <<= 7;
          byte = bytes[offset++];
          id |= byte & 0x7f;
        }
      }

      // parse route
      if (msgHasRoute(type)) {
        if (compressRoute) {
          route = (bytes[offset++]) << 8 | bytes[offset++];
        } else {
          var routeLen = bytes[offset++];
          if (routeLen) {
            route = Buffer.alloc(routeLen);
            copyArray(route, 0, bytes, offset, routeLen);
            route = Protocol.strdecode(route);
          } else {
            route = '';
          }
          offset += routeLen;
        }
      }

      // parse body
      var bodyLen = bytesLen - offset;
      var body = Buffer.alloc(bodyLen);

      copyArray(body, 0, bytes, offset, bodyLen);

      return {
        'id': id, 'type': type, 'compressRoute': compressRoute,
        'route': route, 'body': body
      };
    }
  }



  var copyArray = function (dest, doffset, src, soffset, length) {
    if ('function' === typeof src.copy) {
      // Buffer
      if (dest)
        src.copy(dest, doffset, soffset, soffset + length);
    } else {
      // Uint8Array
      for (var index = 0; index < length; index++) {
        dest[doffset++] = src[soffset++];
      }
    }
  };

  var msgHasId = function (type) {
    return type === Message.TYPE_REQUEST || type === Message.TYPE_RESPONSE;
  };

  var msgHasRoute = function (type) {
    return type === Message.TYPE_REQUEST || type === Message.TYPE_NOTIFY ||
      type === Message.TYPE_PUSH;
  };

  var caculateMsgIdBytes = function (id) {
    var len = 0;
    do {
      len += 1;
      id >>= 7;
    } while (id > 0);
    return len;
  };

  var encodeMsgFlag = function (type, compressRoute, buffer, offset) {
    if (type !== Message.TYPE_REQUEST && type !== Message.TYPE_NOTIFY &&
      type !== Message.TYPE_RESPONSE && type !== Message.TYPE_PUSH) {
      throw new Error('unkonw message type: ' + type);
    }

    buffer[offset] = (type << 1) | (compressRoute ? 1 : 0);

    return offset + MSG_FLAG_BYTES;
  };

  var encodeMsgId = function (id, idBytes, buffer, offset) {
    var index = offset + idBytes - 1;
    buffer[index--] = id & 0x7f;
    while (index >= offset) {
      id >>= 7;
      buffer[index--] = id & 0x7f | 0x80;
    }
    return offset + idBytes;
  };

  var encodeMsgRoute = function (compressRoute, route, buffer, offset) {
    if (compressRoute) {
      if (route > MSG_ROUTE_CODE_MAX) {
        throw new Error('route number is overflow');
      }

      buffer[offset++] = (route >> 8) & 0xff;
      buffer[offset++] = route & 0xff;
    } else {
      if (route) {
        buffer[offset++] = route.length & 0xff;
        copyArray(buffer, offset, route, 0, route.length);
        offset += route.length;
      } else {
        buffer[offset++] = 0;
      }
    }

    return offset;
  };

  var encodeMsgBody = function (msg, buffer, offset) {
    copyArray(buffer, offset, msg, 0, msg.length);
    return offset + msg.length;
  };

}

namespace protobuf {

  export const init = function (opts) {
    //On the serverside, use serverProtos to encode messages send to client
    encoder.init(opts.encoderProtos);
    //On the serverside, user clientProtos to decode messages receive from clients
    decoder.init(opts.decoderProtos);
  };

  export const encode = function (key, msg) {
    return encoder.encode(key, msg);
  };

  export const decode = function (key, msg) {
    return decoder.decode(key, msg);
  };

  export namespace constants {
    export const TYPES = {
      uInt32: 0,
      sInt32: 0,
      int32: 0,
      double: 1,
      string: 2,
      message: 2,
      float: 5,
    };
  }

  export namespace util {
    export function isSimpleType(type: string) {
      return (
        type === 'uInt32' ||
        type === 'sInt32' ||
        type === 'int32' ||
        type === 'uInt64' ||
        type === 'sInt64' ||
        type === 'float' ||
        type === 'double'
      );
    }
  }

  export namespace codec {
    const buffer = new ArrayBuffer(8);
    const float32Array = new Float32Array(buffer);
    const float64Array = new Float64Array(buffer);
    const uInt8Array = new Uint8Array(buffer);

    export const encodeUInt32 = function (n) {
      n = parseInt(n);
      if (isNaN(n) || n < 0) {
        return null;
      }

      var result = [];
      do {
        var tmp = n % 128;
        var next = Math.floor(n / 128);

        if (next !== 0) {
          tmp = tmp + 128;
        }
        result.push(tmp);
        n = next;
      } while (n !== 0);

      return result;
    };

    export const encodeSInt32 = function (n) {
      n = parseInt(n);
      if (isNaN(n)) {
        return null;
      }
      n = n < 0 ? (Math.abs(n) * 2 - 1) : n * 2;

      return encodeUInt32(n);
    };

    export const decodeUInt32 = function (bytes) {
      var n = 0;

      for (var i = 0; i < bytes.length; i++) {
        var m = parseInt(bytes[i]);
        n = n + ((m & 0x7f) * Math.pow(2, (7 * i)));
        if (m < 128) {
          return n;
        }
      }

      return n;
    };

    export const decodeSInt32 = function (bytes) {
      var n = this.decodeUInt32(bytes);
      var flag = ((n % 2) === 1) ? -1 : 1;

      n = ((n % 2 + n) / 2) * flag;

      return n;
    };

    export const encodeFloat = function (float) {
      float32Array[0] = float;
      return uInt8Array;
    };

    export const decodeFloat = function (bytes, offset) {
      if (!bytes || bytes.length < (offset + 4)) {
        return null;
      }

      for (var i = 0; i < 4; i++) {
        uInt8Array[i] = bytes[offset + i];
      }

      return float32Array[0];
    };

    export const encodeDouble = function (double) {
      float64Array[0] = double;
      return uInt8Array.subarray(0, 8);
    };

    export const decodeDouble = function (bytes, offset) {
      if (!bytes || bytes.length < (8 + offset)) {
        return null;
      }

      for (var i = 0; i < 8; i++) {
        uInt8Array[i] = bytes[offset + i];
      }

      return float64Array[0];
    };

    export const encodeStr = function (bytes, offset, str) {
      for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        var codes = encode2UTF8(code);

        for (var j = 0; j < codes.length; j++) {
          bytes[offset] = codes[j];
          offset++;
        }
      }

      return offset;
    };

    /**
     * Decode string from utf8 bytes
     */
    export const decodeStr = function (bytes, offset, length) {
      var array = [];
      var end = offset + length;

      while (offset < end) {
        var code = 0;

        if (bytes[offset] < 128) {
          code = bytes[offset];

          offset += 1;
        } else if (bytes[offset] < 224) {
          code = ((bytes[offset] & 0x3f) << 6) + (bytes[offset + 1] & 0x3f);
          offset += 2;
        } else {
          code = ((bytes[offset] & 0x0f) << 12) + ((bytes[offset + 1] & 0x3f) << 6) + (bytes[offset + 2] & 0x3f);
          offset += 3;
        }

        array.push(code);

      }

      var str = '';
      for (var i = 0; i < array.length;) {
        str += String.fromCharCode.apply(null, array.slice(i, i + 10000));
        i += 10000;
      }

      return str;
    };

    /**
     * Return the byte length of the str use utf8
     */
    export const byteLength = function (str) {
      if (typeof (str) !== 'string') {
        return -1;
      }

      var length = 0;

      for (var i = 0; i < str.length; i++) {
        var code = str.charCodeAt(i);
        length += codeLength(code);
      }

      return length;
    };

    /**
     * Encode a unicode16 char code to utf8 bytes
     */
    function encode2UTF8(charCode) {
      if (charCode <= 0x7f) {
        return [charCode];
      } else if (charCode <= 0x7ff) {
        return [0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f)];
      } else {
        return [0xe0 | (charCode >> 12), 0x80 | ((charCode & 0xfc0) >> 6), 0x80 | (charCode & 0x3f)];
      }
    }

    function codeLength(code) {
      if (code <= 0x7f) {
        return 1;
      } else if (code <= 0x7ff) {
        return 2;
      } else {
        return 3;
      }
    }
  }

  export namespace encoder {
    var codec = protobuf.codec;
    var constant = protobuf.constants;
    var util = protobuf.util;
    export const init = function (protos) {
      this.protos = protos || {};
    }

    export const encode = function (route, msg) {
      var protos = this.protos[route];
      //Check msg
      if (!checkMsg(msg, protos)) {
        return null;
      }

      //Set the length of the buffer 2 times bigger to prevent overflow
      var length = codec.byteLength(JSON.stringify(msg));

      //Init buffer and offset
      var buffer = new ArrayBuffer(length);
      var uInt8Array = new Uint8Array(buffer);
      var offset = 0;

      if (!!protos) {
        offset = encodeMsg(uInt8Array, offset, protos, msg);
        if (offset > 0) {
          return uInt8Array.subarray(0, offset);
        }
      }

      return null;
    }

    /**
 * Check if the msg follow the defination in the protos
 */
    function checkMsg(msg, protos) {
      if (!protos) {
        return false;
      }

      for (var name in protos) {
        var proto = protos[name];

        //All required element must exist
        switch (proto.option) {
          case 'required':
            if (typeof (msg[name]) === 'undefined') {
              return false;
            }
          case 'optional':
            if (typeof (msg[name]) !== 'undefined') {
              if (!!protos.__messages[proto.type]) {
                checkMsg(msg[name], protos.__messages[proto.type]);
              }
            }
            break;
          case 'repeated':
            //Check nest message in repeated elements
            if (!!msg[name] && !!protos.__messages[proto.type]) {
              for (var i = 0; i < msg[name].length; i++) {
                if (!checkMsg(msg[name][i], protos.__messages[proto.type])) {
                  return false;
                }
              }
            }
            break;
        }
      }

      return true;
    }

    function encodeMsg(buffer, offset, protos, msg) {
      for (var name in msg) {
        if (!!protos[name]) {
          var proto = protos[name];

          switch (proto.option) {
            case 'required':
            case 'optional':
              offset = writeBytes(buffer, offset, encodeTag(proto.type, proto.tag));
              offset = encodeProp(msg[name], proto.type, offset, buffer, protos);
              break;
            case 'repeated':
              if (msg[name].length > 0) {
                offset = encodeArray(msg[name], proto, offset, buffer, protos);
              }
              break;
          }
        }
      }

      return offset;
    }

    function encodeProp(value, type, offset, buffer, protos) {
      switch (type) {
        case 'uInt32':
          offset = writeBytes(buffer, offset, codec.encodeUInt32(value));
          break;
        case 'int32':
        case 'sInt32':
          offset = writeBytes(buffer, offset, codec.encodeSInt32(value));
          break;
        case 'float':
          writeBytes(buffer, offset, codec.encodeFloat(value));
          offset += 4;
          break;
        case 'double':
          writeBytes(buffer, offset, codec.encodeDouble(value));
          offset += 8;
          break;
        case 'string':
          var length = codec.byteLength(value);

          //Encode length
          offset = writeBytes(buffer, offset, codec.encodeUInt32(length));
          //write string
          codec.encodeStr(buffer, offset, value);
          offset += length;
          break;
        default:
          if (!!protos.__messages[type]) {
            //Use a tmp buffer to build an internal msg
            var tmpBuffer = new ArrayBuffer(codec.byteLength(JSON.stringify(value)));
            var length = 0;

            length = encodeMsg(tmpBuffer, length, protos.__messages[type], value);
            //Encode length
            offset = writeBytes(buffer, offset, codec.encodeUInt32(length));
            //contact the object
            for (var i = 0; i < length; i++) {
              buffer[offset] = tmpBuffer[i];
              offset++;
            }
          }
          break;
      }

      return offset;
    }

    /**
     * Encode reapeated properties, simple msg and object are decode differented
     */
    function encodeArray(array, proto, offset, buffer, protos) {
      var i = 0;

      if (util.isSimpleType(proto.type)) {
        offset = writeBytes(buffer, offset, encodeTag(proto.type, proto.tag));
        offset = writeBytes(buffer, offset, codec.encodeUInt32(array.length));
        for (i = 0; i < array.length; i++) {
          offset = encodeProp(array[i], proto.type, offset, buffer, undefined);
        }
      } else {
        for (i = 0; i < array.length; i++) {
          offset = writeBytes(buffer, offset, encodeTag(proto.type, proto.tag));
          offset = encodeProp(array[i], proto.type, offset, buffer, protos);
        }
      }

      return offset;
    }

    function writeBytes(buffer, offset, bytes) {
      for (var i = 0; i < bytes.length; i++, offset++) {
        buffer[offset] = bytes[i];
      }

      return offset;
    }

    function encodeTag(type, tag) {
      var value = constant.TYPES[type] || 2;
      return codec.encodeUInt32((tag << 3) | value);
    }


  }

  export namespace decoder {
    var codec = protobuf.codec;
    var util = protobuf.util;
    var buffer;
    var offset = 0;
    export const init = function (protos) {
      this.protos = protos || {};
    }

    export const setProtos = function (protos) {
      if (!!protos) {
        this.protos = protos;
      }
    }

    export const decode = function (route, buf) {
      var protos = this.protos[route];
      buffer = buf;
      offset = 0;
      if (!!protos) {
        return decodeMsg({}, protos, buffer.length);
      }
      return null;
    }

    function decodeMsg(msg, protos, length) {
      while (offset < length) {
        var head = getHead();
        var type = head.type;
        var tag = head.tag;
        var name = protos.__tags[tag];

        switch (protos[name].option) {
          case 'optional':
          case 'required':
            msg[name] = decodeProp(protos[name].type, protos);
            break;
          case 'repeated':
            if (!msg[name]) {
              msg[name] = [];
            }
            decodeArray(msg[name], protos[name].type, protos);
            break;
        }
      }

      return msg;
    }

    /**
     * Test if the given msg is finished
     */
    function isFinish(msg, protos) {
      return (!protos.__tags[peekHead().tag]);
    }
    /**
     * Get property head from protobuf
     */
    function getHead() {
      var tag = codec.decodeUInt32(getBytes());

      return {
        type: tag & 0x7,
        tag: tag >> 3
      };
    }

    /**
     * Get tag head without move the offset
     */
    function peekHead() {
      var tag = codec.decodeUInt32(peekBytes());

      return {
        type: tag & 0x7,
        tag: tag >> 3
      };
    }

    function decodeProp(type, protos = undefined) {
      switch (type) {
        case 'uInt32':
          return codec.decodeUInt32(getBytes());
        case 'int32':
        case 'sInt32':
          return codec.decodeSInt32(getBytes());
        case 'float':
          var float = codec.decodeFloat(buffer, offset);
          offset += 4;
          return float;
        case 'double':
          var double = codec.decodeDouble(buffer, offset);
          offset += 8;
          return double;
        case 'string':
          var length = codec.decodeUInt32(getBytes());

          var str = codec.decodeStr(buffer, offset, length);
          offset += length;

          return str;
        default:
          if (!!protos && !!protos.__messages[type]) {
            var length = codec.decodeUInt32(getBytes());
            var msg = {};
            decodeMsg(msg, protos.__messages[type], offset + length);
            return msg;
          }
          break;
      }
    }

    function decodeArray(array, type, protos) {
      if (util.isSimpleType(type)) {
        var length = codec.decodeUInt32(getBytes());

        for (var i = 0; i < length; i++) {
          array.push(decodeProp(type));
        }
      } else {
        array.push(decodeProp(type, protos));
      }
    }

    function getBytes(flag = false) {
      var bytes = [];
      var pos = offset;
      flag = flag || false;

      var b;

      do {
        b = buffer[pos];
        bytes.push(b);
        pos++;
      } while (b >= 128);

      if (!flag) {
        offset = pos;
      }
      return bytes;
    }

    function peekBytes() {
      return getBytes(true);
    }

  }
}


class Emitter {
  private _callbacks: { [event: string]: Function[] };

  constructor(obj?: any) {
    if (obj) return this.mixin(obj);
  }

  /**
   * Mixin the emitter properties.
   *
   * @param {Object} obj
   * @return {Object}
   * @api private
   */
  private mixin(obj: any) {
    for (var key in Emitter.prototype) {
      obj[key] = Emitter.prototype[key];
    }
    return obj;
  }

  /**
   * Listen on the given `event` with `fn`.
   *
   * @param {String} event
   * @param {Function} fn
   * @return {Emitter}
   * @api public
   */
  public on(event: string, fn: Function) {
    this._callbacks = this._callbacks || {};
    (this._callbacks[event] = this._callbacks[event] || []).push(fn);
    return this;
  }

  /**
   * Adds an `event` listener that will be invoked a single
   * time then automatically removed.
   *
   * @param {String} event
   * @param {Function} fn
   * @return {Emitter}
   * @api public
   */
  public once(event: string, fn: Function) {
    const self = this;
    this._callbacks = this._callbacks || {};

    function on() {
      self.off(event, on);
      fn.apply(this, arguments);
    }

    (fn as any)._off = on;
    this.on(event, on);
    return this;
  }

  /**
   * Remove the given callback for `event` or all
   * registered callbacks.
   *
   * @param {String} event
   * @param {Function} fn
   * @return {Emitter}
   * @api public
   */
  public off(event?: string, fn?: Function) {
    this._callbacks = this._callbacks || {};

    // all
    if (arguments.length === 0) {
      this._callbacks = {};
      return this;
    }

    // specific event
    const callbacks = this._callbacks[event];
    if (!callbacks) return this;

    // remove all handlers
    if (arguments.length === 1) {
      delete this._callbacks[event];
      return this;
    }

    // remove specific handler
    const i = callbacks.findIndex((callback: Function) => callback === (fn as any)._off || callback === fn);
    if (i !== -1) callbacks.splice(i, 1);
    return this;
  }

  /**
   * Emit `event` with the given args.
   *
   * @param {String} event
   * @param {Mixed} ...
   * @return {Emitter}
   */
  public emit(event: string, ...args: any[]) {
    this._callbacks = this._callbacks || {};
    const callbacks = this._callbacks[event];

    if (callbacks) {
      callbacks.slice().forEach((callback: Function) => callback.apply(this, args));
    }

    return this;
  }

  /**
   * Return array of callbacks for `event`.
   *
   * @param {String} event
   * @return {Array}
   * @api public
   */
  public listeners(event: string) {
    this._callbacks = this._callbacks || {};
    return this._callbacks[event] || [];
  }

  /**
   * Check if this emitter has `event` handlers.
   *
   * @param {String} event
   * @return {Boolean}
   * @api public
   */
  public hasListeners(event: string) {
    return this.listeners(event).length > 0;
  }
}

class PinusClient extends Emitter {
  readonly JS_WS_CLIENT_TYPE = 'js-websocket';
  readonly JS_WS_CLIENT_VERSION = '0.0.1';

  readonly RES_OK = 200;
  readonly RES_FAIL = 500;
  readonly RES_OLD_CLIENT = 501;

  private socket: WebSocket | null = null;

  private heartbeatInterval = 0;
  private heartbeatTimeout = 0;
  private nextHeartbeatTimeout = 0;
  private gapThreshold = 100;   // heartbeat gap threashold
  private heartbeatId = null;
  private heartbeatTimeoutId = null;

  private handshakeCallback: ((data: any) => void) | null = null;
  private initCallback: ((err: Error | null) => void) | null = null;
  private handshakeBuffer: any = {
    'sys': {
      type: this.JS_WS_CLIENT_TYPE,
      version: this.JS_WS_CLIENT_VERSION
    },
    'user': {}
  };

  private reqId = 0;
  private callbacks: {
    [key: number]: (data: any) => void;
  } = {}
  private handlers: {
    [key: number]: (data: any) => void;
  } = {}

  private routeMap: {
    [key: number]: (data: any) => void
  } = {}

  constructor() {
    super();
    this.handlers[Protocol.Package.TYPE_HANDSHAKE] = this.handshake.bind(this);
    this.handlers[Protocol.Package.TYPE_HEARTBEAT] = this.heartbeat.bind(this);
    this.handlers[Protocol.Package.TYPE_DATA] = this.onData.bind(this);
    this.handlers[Protocol.Package.TYPE_KICK] = this.onKick.bind(this);
  }

  private initWebSocket(url: string, cb) {
    console.log('connect to ' + url);

    const onopen = (event: Event) => {
      var obj = Protocol.Package.encode(Protocol.Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(this.handshakeBuffer)));
      this.send(obj);
    };


    const onmessage = (event) => {
      this.processPackage(Protocol.Package.decode(event.data));
      // new package arrived, update the heartbeat timeout
      if (this.heartbeatTimeout) {
        this.nextHeartbeatTimeout = Date.now() + this.heartbeatTimeout;
      }
    };

    const onerror = (event) => {
      this.emit('io-error', event);
      console.error('socket error: ');
    };
    const onclose = (event) => {
      this.emit('close', event);
      console.error('socket close: ');
    };
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = onopen;
    this.socket.onmessage = onmessage;
    this.socket.onerror = onerror;
    this.socket.onclose = onclose;
  }

  dict
  private sendMessage(reqId, route, msg) {
    var type = reqId ? Protocol.Message.TYPE_REQUEST : Protocol.Message.TYPE_NOTIFY;

    //compress message by protobuf
    var protos = !!this.data.protos ? this.data.protos.client : {};
    if (!!protos[route]) {
      msg = protobuf.encode(route, msg);
    } else {
      msg = Protocol.strencode(JSON.stringify(msg));
    }


    var compressRoute = 0;
    if (this.dict && this.dict[route]) {
      route = this.dict[route];
      compressRoute = 1;
    }


    msg = Protocol.Message.encode(reqId, type, compressRoute, route, msg);
    var packet = Protocol.Package.encode(Protocol.Package.TYPE_DATA, msg);


    this.send(packet);
  };

  private send(packet: any) {
    if (this.socket) {
      this.socket.send(packet);
    }
  }

  private heartbeat(data) {
    if (!this.heartbeatInterval) {
      // no heartbeat
      return;
    }

    var obj = Protocol.Package.encode(Protocol.Package.TYPE_HEARTBEAT);
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }

    if (this.heartbeatId) {
      // already in a heartbeat interval
      return;
    }

    this.heartbeatId = setTimeout(() => {
      this.heartbeatId = null;
      this.send(obj);

      this.nextHeartbeatTimeout = Date.now() + this.heartbeatTimeout;
      this.heartbeatTimeoutId = setTimeout(() => this.heartbeatTimeoutCb, this.heartbeatTimeout);
    }, this.heartbeatInterval);
  };

  private heartbeatTimeoutCb() {
    const gap = this.nextHeartbeatTimeout - Date.now();
    if (gap > this.gapThreshold) {
      this.heartbeatTimeoutId = setTimeout(() => this.heartbeatTimeoutCb, gap);
    } else {
      console.error('server heartbeat timeout');
      this.emit('heartbeat timeout');
      this.disconnect();
    }
  };

  private handshake(data) {
    data = JSON.parse(Protocol.strdecode(data));
    if (data.code === this.RES_OLD_CLIENT) {
      this.emit('error', 'client version not fullfill');
      return;
    }

    if (data.code !== this.RES_OK) {
      this.emit('error', 'handshake fail');
      return;
    }

    this.handshakeInit(data);

    var obj = Protocol.Package.encode(Protocol.Package.TYPE_HANDSHAKE_ACK);
    this.send(obj);
    if (this.initCallback) {
      this.initCallback(this.socket);
      this.initCallback = null;
    }
  };

  private onData(data) {

    //probuff decode
    const msg = Protocol.Message.decode(data);

    if (msg.id > 0) {
      msg.route = this.routeMap[msg.id];
      delete this.routeMap[msg.id];
      if (!msg.route) {
        return;
      }
    }

    msg.body = this.deCompose(msg);

    this.processMessage(msg);
  };

  private processMessage(msg) {
    if (!msg.id) {
      // server push message
      this.emit(msg.route, msg.body);
      return;
    }

    //if have a id then find the callback function with the request
    var cb = this.callbacks[msg.id];

    delete this.callbacks[msg.id];
    if (typeof cb !== 'function') {
      return;
    }

    cb(msg.body);
    return;
  };

  private deCompose(msg) {
    var protos = !!this.data.protos ? this.data.protos.server : {};
    var abbrs = this.data.abbrs;
    var route = msg.route;

    //Decompose route from dict
    if (msg.compressRoute) {
      if (!abbrs[route]) {
        return {};
      }

      route = msg.route = abbrs[route];
    }
    if (!!protos[route]) {
      return protobuf.decode(route, msg.body);
    } else {
      return JSON.parse(Protocol.strdecode(msg.body));
    }
    return msg;
  };

  private onKick(data) {
    this.emit('onKick');
  };


  private processPackage(msg) {
    this.handlers[msg.type](msg.body);
  };



  private handshakeInit(data) {
    if (data.sys && data.sys.heartbeat) {
      this.heartbeatInterval = data.sys.heartbeat * 1000;   // heartbeat interval
      this.heartbeatTimeout = this.heartbeatInterval * 2;        // max heartbeat timeout
    } else {
      this.heartbeatInterval = 0;
      this.heartbeatTimeout = 0;
    }

    this.initData(data);

    if (typeof this.handshakeCallback === 'function') {
      this.handshakeCallback(data.user);
    }
  };

  data
  private initData(data) {
    if (!data || !data.sys) {
      return;
    }
    this.data = this.data || {};
    var dict = data.sys.dict;
    var protos = data.sys.protos;

    //Init compress dict
    if (dict) {
      this.data.dict = dict;
      this.data.abbrs = {};

      for (var route in dict) {
        this.data.abbrs[dict[route]] = route;
      }
    }

    //Init protobuf protos
    if (protos) {
      this.data.protos = {
        server: protos.server || {},
        client: protos.client || {}
      };
      if (!!protobuf) {
        protobuf.init({ encoderProtos: protos.client, decoderProtos: protos.server });
      }
    }
  }


  public init(params: { host: string, port?: number, handshakeCallback?: (data: any) => void }, cb: (err: Error | null) => void) {
    this.initCallback = cb;
    const { host, port, handshakeCallback } = params;

    let url = 'ws://' + host;
    if (port) {
      url += ':' + port;
    }
    this.handshakeCallback = handshakeCallback;
    this.initWebSocket(url, cb);
  }

  public disconnect() {
    if (this.socket) {
      if (this.socket.disconnect) this.socket.disconnect();
      if (this.socket.close) this.socket.close();
      console.log('disconnect');
      this.socket = null;
    }

    if (this.heartbeatId) {
      clearTimeout(this.heartbeatId);
      this.heartbeatId = null;
    }
    if (this.heartbeatTimeoutId) {
      clearTimeout(this.heartbeatTimeoutId);
      this.heartbeatTimeoutId = null;
    }
  };

  public request(route, msg, cb) {
    if (arguments.length === 2 && typeof msg === 'function') {
      cb = msg;
      msg = {};
    } else {
      msg = msg || {};
    }
    route = route || msg.route;
    if (!route) {
      return;
    }

    this.reqId++;
    this.sendMessage(this.reqId, route, msg);

    this.callbacks[this.reqId] = cb;
    this.routeMap[this.reqId] = route;

  };
}

export { PinusClient }
