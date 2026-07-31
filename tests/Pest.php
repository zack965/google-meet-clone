<?php

use Aws\ChimeSDKMeetings\ChimeSDKMeetingsClient;
use Aws\Polly\PollyClient;
use Aws\S3\S3Client;
use Aws\TranscribeService\TranscribeServiceClient;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Mockery\MockInterface;
use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
|
| The closure you provide to your test functions is always bound to a specific PHPUnit test
| case class. By default, that class is "PHPUnit\Framework\TestCase". Of course, you may
| need to change it using the "pest()" function to bind different classes or traits.
|
*/

pest()->extend(TestCase::class)
    ->use(RefreshDatabase::class)
    ->in('Feature');

/*
|--------------------------------------------------------------------------
| Expectations
|--------------------------------------------------------------------------
|
| When you're writing tests, you often need to check that values meet certain conditions. The
| "expect()" function gives you access to a set of "expectations" methods that you can use
| to assert different things. Of course, you may extend the Expectation API at any time.
|
*/

expect()->extend('toBeOne', function () {
    return $this->toBe(1);
});

/*
|--------------------------------------------------------------------------
| Functions
|--------------------------------------------------------------------------
|
| While Pest is very powerful out-of-the-box, you may have some testing code specific to your
| project that you don't want to repeat in every file. Here you can also expose helpers as
| global functions to help you to reduce the number of lines of code in your test files.
|
*/

function something()
{
    // ..
}

/**
 * Bind a Mockery double for the AWS Chime SDK client into the container so
 * tests never hit real AWS infrastructure.
 */
function mockChimeClient(): MockInterface
{
    $mock = Mockery::mock(ChimeSDKMeetingsClient::class);

    app()->instance(ChimeSDKMeetingsClient::class, $mock);

    return $mock;
}

/**
 * Bind a Mockery double for the AWS S3 client into the container so tests
 * never hit real AWS infrastructure.
 */
function mockS3Client(): MockInterface
{
    $mock = Mockery::mock(S3Client::class);

    app()->instance(S3Client::class, $mock);

    return $mock;
}

/**
 * Bind a Mockery double for the AWS Transcribe client into the container so
 * tests never hit real AWS infrastructure.
 */
function mockTranscribeClient(): MockInterface
{
    $mock = Mockery::mock(TranscribeServiceClient::class);

    app()->instance(TranscribeServiceClient::class, $mock);

    return $mock;
}

/**
 * Bind a Mockery double for the AWS Polly client into the container so tests
 * never hit real AWS infrastructure.
 */
function mockPollyClient(): MockInterface
{
    $mock = Mockery::mock(PollyClient::class);

    app()->instance(PollyClient::class, $mock);

    return $mock;
}
