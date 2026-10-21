# language: en
Feature: Two clients access two remote servers
  Each client receives a credential for its assigned server only.

  Background:
    Given I run checks from a client container

  Scenario: Servers have distinct instance IDs
    When I request selection metadata from both servers
    Then each server reports its expected instance ID

  Scenario: Private metadata requires a valid credential
    When I request private metadata without a credential and with an invalid credential
    Then every request is rejected with status 401

  Scenario: A client attaches to its assigned server
    When I attach to the assigned server with its issued credential
    Then I can read the state directory, version, and identities

  Scenario: A mismatched server instance ID is rejected
    When I provide the other server's instance ID
    Then the SDK refuses to send a credentialed request

  Scenario: A credential for one server cannot access the other
    When I use my credential against the other server
    Then the server rejects the request with status 401
