# language: en
@client-contracts
Feature: Remote client and HTTP API regressions

  @remote-http-endpoint
  Scenario Outline: A remote client uses its explicitly configured HTTP endpoint and credential
    When a remote SDK client attaches to server <server> over HTTP
    Then the attached client reads protected metadata from the selected server

    @server-a
    Examples: Server A
      | server |
      | A      |

    @server-b
    Examples: Server B
      | server |
      | B      |

  @todo @limit-json-request-size
  Scenario Outline: The server limits JSON request size
    Given a small authenticated JSON request to server <server> succeeds
    When I send an authenticated JSON request with 2 MiB of padding
    Then the server responds with status 413

    @server-a
    Examples: Server A
      | server |
      | A      |

    @server-b
    Examples: Server B
      | server |
      | B      |
