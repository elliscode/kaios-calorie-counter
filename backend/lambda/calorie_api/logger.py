def log(*content):
    print(f"{content}")


if __name__ == "__main__":
    log("This is a test message")
    log("This is a test message with some context", {"key1": "user", "key2": "1234567890"})
