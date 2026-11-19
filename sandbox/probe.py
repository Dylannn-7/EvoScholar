"""Read a bounded response from a service in the current container."""
import http.client
import json
import sys


def main():
    port, path, timeout = sys.argv[1:]
    if not 1024 <= int(port) <= 65535 or not path.startswith("/") or path.startswith("//"):
        raise ValueError("Invalid service target")
    connection = http.client.HTTPConnection("127.0.0.1", int(port), timeout=int(timeout))
    try:
        connection.request("GET", path, headers={"Accept-Encoding": "identity", "Connection": "close"})
        response = connection.getresponse()
        if 300 <= response.status < 400:
            raise ValueError("Service redirects are disabled")
        print(json.dumps({"status": response.status, "body": response.read(20000).decode("utf-8", errors="replace")}))
    finally:
        connection.close()


if __name__ == "__main__":
    main()
